"""The MCP tools, called directly (the SDK itself is stubbed)."""

import json

import pytest
from conftest import SID, ToolError
from test_sessions import OTHER, record

TOOLS = {
    "list_meetings",
    "get_transcript",
    "clean_transcript",
    "correct_speakers",
    "search_transcripts",
    "create_cleanup",
    "finish_cleanup",
    "list_cleanups",
    "get_cleanup",
    "get_vocab",
    "add_vocab",
    "remove_vocab",
}

JAN = 1_767_225_600_000  # 2026-01-01T00:00:00Z
FEB = 1_769_904_000_000  # 2026-02-01T00:00:00Z


@pytest.fixture
def meetings(client):
    diag = [{"names": ["Ada", "Grace (Presentation)", "Fireflies.ai Notetaker", "?"]}]
    client.post(f"/api/sessions/{SID}", json=record(started=JAN, diagnostics=diag))
    client.post(f"/api/sessions/{OTHER}", json=record(started=FEB, platform="zoom"))


def test_every_tool_is_registered(mcp):
    assert set(mcp) == TOOLS


def test_list_meetings(mcp, meetings):
    got = mcp["list_meetings"]()
    assert [m["sessionId"] for m in got] == [OTHER, SID]
    assert got[1]["startedAt"] == "2026-01-01T00:00:00+00:00"
    assert got[1]["participants"] == ["Ada", "Grace"]
    assert got[1]["title"] is None and got[1]["cleanup"] is None


def test_list_meetings_bounds_and_limit(mcp, meetings):
    assert [m["sessionId"] for m in mcp["list_meetings"](since="2026-01-15")] == [OTHER]
    until = mcp["list_meetings"](until="2026-01-15T00:00:00+00:00")
    assert [m["sessionId"] for m in until] == [SID]
    assert len(mcp["list_meetings"](limit=1)) == 1


def test_get_transcript(mcp, meetings):
    text = mcp["get_transcript"](SID)
    assert text.splitlines() == [
        f"Meeting {SID}, started 2026-01-01T00:00:00+00:00, on meet",
        "Participants: Ada, Grace",
        "",
        "[0:00] Ada: hello there",
        "[0:02] Unknown: hm",
    ]


def test_a_meeting_title_names_the_meeting(client, mcp):
    client.post(f"/api/sessions/{SID}", json=record(started=JAN, title="Kickoff"))
    first = mcp["create_cleanup"](SID, model="m")
    mcp["finish_cleanup"](SID, first["id"], notes={"title": "Generated"})
    [meeting] = mcp["list_meetings"]()
    assert meeting["title"] == "Kickoff"
    assert mcp["get_transcript"](SID).startswith(f'Meeting "Kickoff" {SID},')


@pytest.mark.parametrize("sid", [OTHER.replace("a", "f"), "../x"])
def test_get_transcript_of_nothing(mcp, sid):
    with pytest.raises(ToolError):
        mcp["get_transcript"](sid)


def test_search(mcp, meetings):
    hits = mcp["search_transcripts"]("HELLO")
    assert [h["sessionId"] for h in hits] == [OTHER, SID]
    assert hits[0] | {"startedAt": None} == {
        "sessionId": OTHER,
        "startedAt": None,
        "at": "0:00",
        "speaker": "Ada",
        "text": "hello there",
    }
    assert len(mcp["search_transcripts"]("hello", limit=1)) == 1
    assert mcp["search_transcripts"]("absent") == []
    with pytest.raises(ToolError):
        mcp["search_transcripts"]("   ")


def test_cleanup_lifecycle(mcp, meetings):
    first = mcp["create_cleanup"](SID, model="m1", job_id="j")
    assert first["status"] == "running"
    second = mcp["create_cleanup"](SID, model="m2")
    assert mcp["get_cleanup"](SID) is None

    done = mcp["finish_cleanup"](SID, first["id"], notes={"title": "Kickoff"})
    assert done["status"] == "done" and done["title"] == "Kickoff"
    assert "notes" not in done
    failed = mcp["finish_cleanup"](SID, second["id"], error="model crashed")
    assert failed["status"] == "failed"

    assert [c["id"] for c in mcp["list_cleanups"](SID)] == [second["id"], first["id"]]
    assert mcp["get_cleanup"](SID)["notes"] == {"title": "Kickoff"}
    assert mcp["get_cleanup"](SID, second["id"])["error"] == "model crashed"
    assert mcp["get_cleanup"](SID, "000000000000") is None

    [meeting] = [m for m in mcp["list_meetings"]() if m["sessionId"] == SID]
    assert meeting["title"] == "Kickoff" and meeting["cleanup"] == "failed"


def test_cleanup_errors(mcp, meetings, server, monkeypatch):
    with pytest.raises(ToolError):
        mcp["create_cleanup"](OTHER.replace("a", "f"), model="m")
    c = mcp["create_cleanup"](SID, model="m")
    with pytest.raises(ToolError):
        mcp["finish_cleanup"](SID, c["id"])
    with pytest.raises(ToolError):
        mcp["finish_cleanup"](SID, c["id"], notes={}, error="x")
    with pytest.raises(ToolError):
        mcp["finish_cleanup"](SID, "../../session", notes={})
    monkeypatch.setattr(server, "MAX_SESSION_BYTES", 10)
    with pytest.raises(ToolError):
        mcp["finish_cleanup"](SID, c["id"], notes={"summary": "x" * 20})


def test_vocab_tools(mcp, server):
    assert mcp["get_vocab"]() == []
    assert mcp["add_vocab"](["Ada", " Ada ", "NeMo"]) == ["Ada", "NeMo"]
    assert mcp["remove_vocab"](["Ada", "absent"]) == ["NeMo"]
    assert json.loads(server.VOCAB.read_text()) == ["NeMo"]
