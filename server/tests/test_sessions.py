"""The session browser API and the vocabulary routes."""

import json

import pytest
from conftest import SID

OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
JSON = {"content-type": "application/json"}


def record(started=1_700_000_000_000, **extra):
    return {
        "startedAt": started,
        "stoppedAt": started + 60_000,
        "platform": "meet",
        "segments": [
            {
                "speaker": "Ada",
                "start": 0,
                "end": 1,
                "text": "hello there",
                "at": started,
            },
            {"speaker": "Unknown", "start": 2, "end": 3, "text": "hm", "at": started},
        ],
        **extra,
    }


def test_post_then_read_a_session(client):
    assert client.post(f"/api/sessions/{SID}", json=record()).json() == {"ok": True}
    got = client.get(f"/api/sessions/{SID}").json()
    assert got["session"]["platform"] == "meet" and got["live"] is False
    [listed] = client.get("/api/sessions").json()
    assert listed["sessionId"] == SID
    assert listed["speakers"] == ["Ada", "Unknown"] and listed["words"] == 3


def test_listing_is_newest_first(client):
    client.post(f"/api/sessions/{SID}", json=record(started=1))
    client.post(f"/api/sessions/{OTHER}", json=record(started=2))
    assert [s["sessionId"] for s in client.get("/api/sessions").json()] == [OTHER, SID]


@pytest.mark.parametrize(
    "bad",
    [
        {"segments": "nope", "startedAt": "yesterday"},
        {"segments": [{"speaker": 1}, None, {"text": "x"}], "startedAt": True},
        {"segments": [{"speaker": "A", "text": "t", "start": "0"}], "platform": []},
    ],
)
def test_a_malformed_record_does_not_break_anything(client, mcp, bad):
    client.post(f"/api/sessions/{OTHER}", json=record())
    client.post(f"/api/sessions/{SID}", json=bad)
    listing = client.get("/api/sessions").json()
    assert {s["sessionId"] for s in listing} == {SID, OTHER}
    assert client.get(f"/api/sessions/{SID}").status_code == 200
    assert len(mcp["list_meetings"]()) == 1
    assert mcp["search_transcripts"]("hello")[0]["sessionId"] == OTHER
    assert mcp["get_transcript"](SID).endswith("\n")


def test_unreadable_record_is_skipped(client, server):
    folder = server.RECORDINGS / SID
    folder.mkdir(parents=True)
    (folder / "session.json").write_text("{trunc")
    [listed] = client.get("/api/sessions").json()
    assert listed["hasRecord"] is False


@pytest.mark.parametrize("body", [b"not json", b"[1]", b'"x"'])
def test_post_rejects_non_objects(client, body):
    r = client.post(f"/api/sessions/{SID}", content=body, headers=JSON)
    assert r.status_code == 400


def test_post_rejects_oversized_records(client, server, monkeypatch):
    monkeypatch.setattr(server, "MAX_SESSION_BYTES", 100)
    body = b"{" + b" " * 200 + b"}"
    r = client.post(f"/api/sessions/{SID}", content=body, headers=JSON)
    assert r.status_code == 413
    assert not (server.RECORDINGS / SID).exists()


@pytest.mark.parametrize("sid", ["../etc", "not-a-uuid", OTHER.upper()])
def test_bad_session_ids_are_404(client, sid):
    assert client.get(f"/api/sessions/{sid}").status_code == 404
    assert client.post(f"/api/sessions/{sid}", json={}).status_code in (404, 405)


def test_unknown_session_is_404(client):
    assert client.get(f"/api/sessions/{SID}").status_code == 404


def test_audio_route_only_serves_channel_stems(client, server):
    folder = server.RECORDINGS / SID
    folder.mkdir(parents=True)
    (folder / "session.json").write_text("{}")
    (folder / "tab.flac").write_bytes(b"fLaC")
    assert client.get(f"/api/sessions/{SID}/audio/tab").status_code == 200
    assert client.get(f"/api/sessions/{SID}/audio/session").status_code == 404
    assert client.get(f"/api/sessions/{SID}/audio/mic").status_code == 404


def test_vocab_round_trip_is_cleaned(client, server):
    assert client.get("/api/vocab").json() == {"phrases": []}
    phrases = ["  Ada  Lovelace ", "", "Ada Lovelace", 3, "x" * 101, "NeMo"]
    r = client.put("/api/vocab", json={"phrases": phrases})
    assert r.json() == {"phrases": ["Ada Lovelace", "NeMo"]}
    assert json.loads(server.VOCAB.read_text()) == ["Ada Lovelace", "NeMo"]
    assert client.get("/api/vocab").json() == {"phrases": ["Ada Lovelace", "NeMo"]}


def test_vocab_rejects_garbage(client):
    assert client.put("/api/vocab", content=b"nope").status_code == 400
    assert client.put("/api/vocab", json=[1]).json() == {"phrases": []}


def test_vocab_rejects_oversized_bodies(client, server, monkeypatch):
    monkeypatch.setattr(server, "MAX_VOCAB_BYTES", 10)
    assert client.put("/api/vocab", json={"phrases": ["x" * 20]}).status_code == 413


def test_vocab_is_capped(server):
    many = [f"p{i}" for i in range(server.MAX_PHRASES + 5)]
    assert len(server._clean_phrases(many)) == server.MAX_PHRASES


def test_ui_is_served(client):
    r = client.get("/")
    assert r.status_code == 200 and "<title>scribe</title>" in r.text


def test_session_posts_must_be_json(client):
    r = client.post(
        f"/api/sessions/{SID}",
        content=json.dumps(record()),
        headers={"content-type": "text/plain"},
    )
    assert r.status_code == 415
