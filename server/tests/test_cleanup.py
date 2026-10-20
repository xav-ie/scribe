"""Transcript cleanup against a fake OpenAI-compatible chat server: chunking,
the request, the safety check, the stored copy, and the API and MCP flags."""

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from conftest import SID, ToolError, settle
from test_sessions import record

JSON = {"content-type": "application/json"}


def tidy(line):
    """What the fake model does to a line: drop "um", capitalize, add a period."""
    m = re.match(r"^(\[\d+:\d\d\] [^:]+:) ?(.*)$", line)
    text = " ".join(w for w in m.group(2).split() if w != "um")
    return f"{m.group(1)} {text[:1].upper()}{text[1:]}." if text else m.group(1)


class FakeModel:
    """An OpenAI-compatible /v1/chat/completions. `answer` maps the chunk's
    transcript lines to the reply's lines; `fail` answers 500."""

    def __init__(self):
        self.requests = []
        self.answer = lambda lines: [tidy(line) for line in lines]
        self.fail = False
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                fake.requests.append((self.path, body))
                if fake.fail:
                    self.send_response(500)
                    self.end_headers()
                    return
                user = body["messages"][1]["content"]
                lines = user.split("<transcript>\n")[1].split("\n</transcript>")[0]
                reply = {
                    "model": "fake-cleanup",
                    "choices": [
                        {
                            "message": {
                                "content": "\n".join(fake.answer(lines.split("\n")))
                            }
                        }
                    ],
                }
                data = json.dumps(reply).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.http.server_port}/v1"
        threading.Thread(target=self.http.serve_forever, daemon=True).start()


@pytest.fixture
def model(server, monkeypatch):
    fake = FakeModel()
    monkeypatch.setattr(server, "CLEANUP_URL", fake.url)
    monkeypatch.setattr(server, "CLEANUP_AUTO", True)
    monkeypatch.setattr(server, "_JOBS", {})
    yield fake
    fake.http.shutdown()


def meeting(**extra):
    r = record(**extra)
    r["segments"] = [
        {"speaker": "Ada", "start": 0, "text": "um so the the cost is fine", "at": 1},
        {
            "speaker": "Grace",
            "start": 5,
            "text": "so that's two off the price",
            "at": 2,
        },
        {"speaker": "Ada", "start": 9, "text": "um", "at": 3},
    ]
    return r


def done(server, sid=SID):
    def finished():
        run = server._cleaning(sid)
        return run and run["status"] in ("done", "failed")

    settle(finished, timeout=5)
    return server._cleaning(sid)


def words(n, w="word"):
    return " ".join([w] * n)


# --- chunking and the request ------------------------------------------------


def test_chunks_are_whole_lines_of_about_250_words(server):
    lines = [("0:00", "A", words(100)) for _ in range(6)] + [("0:01", "B", words(400))]
    lines += [("0:02", "A", words(10))]
    chunks = server._chunks(lines)
    assert [list(c) for c in chunks] == [[0, 1], [2, 3], [4, 5], [6], [7]]
    assert server._chunks([]) == []


def test_previous_is_up_to_80_words_of_up_to_5_lines(server):
    lines = [("0:00", "A", words(50, "x")), ("0:01", "B", words(50, "y"))]
    lines += [("0:02", "A", f"w{i}") for i in range(7)]
    # The earlier line is cut from its start to fit 80 words.
    assert server._previous(lines[:2] + [("0:03", "C", "z")], 2) == [
        ("0:00", "A", words(30, "x")),
        ("0:01", "B", words(50, "y")),
    ]
    assert [x for _, _, x in server._previous(lines, 9)] == [
        f"w{i}" for i in range(2, 7)
    ]
    assert server._previous(lines, 0) == []


def test_request_follows_the_model_card(server, model, client, monkeypatch):
    long = record()
    long["segments"] = [
        {"speaker": "Ada", "start": i * 10, "text": words(100, f"t{i}"), "at": 1}
        for i in range(4)
    ]
    long["diagnostics"] = [{"names": ["Ada", "Grace"]}]
    monkeypatch.setattr(server, "CLEANUP_AUTO", False)
    client.post(f"/api/sessions/{SID}", json=long)
    assert client.post(f"/api/sessions/{SID}/clean", json={}).status_code == 202
    assert done(server)["status"] == "done"

    _, prompt, _ = server._cleanup_kit()
    (path, first), (_, second) = model.requests
    assert path == "/v1/chat/completions"
    assert first["messages"][0] == {"role": "system", "content": prompt}
    assert first["temperature"] == 0
    assert first["chat_template_kwargs"] == {"enable_thinking": False}
    assert "model" not in first
    assert first["messages"][1]["content"] == (
        "<context>\nparticipants: Ada, Grace\n</context>\n<transcript>\n"
        f"[0:00] Ada: {words(100, 't0')}\n[0:10] Ada: {words(100, 't1')}\n</transcript>"
    )
    assert second["messages"][1]["content"].startswith(
        "<context>\nparticipants: Ada, Grace\n</context>\n<previous>\n"
        f"[0:10] Ada: {words(80, 't1')}\n</previous>\n<transcript>\n[0:20] Ada: "
    )
    chars = len(f"[0:00] Ada: {words(100, 't0')}\n[0:10] Ada: {words(100, 't1')}")
    assert first["max_tokens"] == int(1.3 * (chars // 3)) + 64

    monkeypatch.setattr(server, "CLEANUP_MODEL", "scribe-cleanup")
    client.post(f"/api/sessions/{SID}/clean", json={})
    done(server)
    settle(lambda: len(model.requests) == 4)
    assert model.requests[-1][1]["model"] == "scribe-cleanup"
    assert (
        server._cleaned_copy(SID, server._read_session(server.RECORDINGS / SID))[
            "model"
        ]
        == "scribe-cleanup"
    )


# --- off unless configured ---------------------------------------------------


def test_off_by_default(server, client, mcp):
    assert server.CLEANUP_URL == ""
    client.post(f"/api/sessions/{SID}", json=meeting())
    folder = server.RECORDINGS / SID
    assert not (folder / "cleaned.json").exists()
    assert not (folder / "cleaning.json").exists()
    assert client.get("/api/info").json()["cleanup"] is False
    got = client.get(f"/api/sessions/{SID}?cleaned=true").json()["cleaned"]
    assert got == {"configured": False, "available": False, "copy": None, "run": None}
    assert client.post(f"/api/sessions/{SID}/clean", json={}).status_code == 409
    with pytest.raises(ToolError):
        mcp["clean_transcript"](SID)
    with pytest.raises(ToolError):
        mcp["get_transcript"](SID, cleaned=True)


def test_auto_off_cleans_only_on_request(server, model, client, mcp, monkeypatch):
    monkeypatch.setattr(server, "CLEANUP_AUTO", False)
    client.post(f"/api/sessions/{SID}", json=meeting())
    assert model.requests == [] and server._cleaning(SID) is None
    assert mcp["clean_transcript"](SID)["status"] in ("queued", "running", "done")
    assert done(server)["status"] == "done"


# --- the cleaned copy --------------------------------------------------------


def test_cleans_after_the_recording_without_touching_the_transcript(
    server, model, client
):
    client.post(f"/api/sessions/{SID}", json=meeting())
    raw = (server.RECORDINGS / SID / "session.json").read_bytes()
    run = done(server)
    assert run["status"] == "done" and run["chunksDone"] == run["chunks"] == 1
    assert (server.RECORDINGS / SID / "session.json").read_bytes() == raw

    plain = client.get(f"/api/sessions/{SID}").json()
    assert plain["session"]["segments"][0]["text"] == "um so the the cost is fine"
    copy = plain["cleaned"]["copy"]
    assert plain["cleaned"]["available"] and "lines" not in copy
    assert copy["model"] == "fake-cleanup" and copy["lineCount"] == 3
    assert copy["promptVersion"] == server._cleanup_kit()[2]
    assert copy["stale"] is False and copy["keptRaw"] == 0

    lines = client.get(f"/api/sessions/{SID}?cleaned=true").json()["cleaned"]["copy"]
    assert [(x["speaker"], x["text"]) for x in lines["lines"]] == [
        ("Ada", "So the the cost is fine."),
        ("Grace", "So that's two off the price."),
        ("Ada", ""),
    ]


def test_mlx_default_model_name_is_not_recorded(server):
    assert server._model_name("default_model") is None
    assert server._model_name(None) is None
    assert server._model_name("x/scribe-cleanup.gguf") == "x/scribe-cleanup.gguf"


def test_the_guard_keeps_a_line_whose_number_changed(server, model, client):
    model.answer = lambda lines: [tidy(line).replace("two", "20") for line in lines]
    client.post(f"/api/sessions/{SID}", json=meeting())
    done(server)
    copy = client.get(f"/api/sessions/{SID}?cleaned=true").json()["cleaned"]["copy"]
    assert copy["keptRaw"] == 1
    assert copy["lines"][1] == {
        "start": 5,
        "speaker": "Grace",
        "text": "so that's two off the price",
        "keptRaw": True,
    }
    assert copy["lines"][0]["text"] == "So the the cost is fine."


def test_a_broken_answer_keeps_the_whole_chunk_raw(server, model, client):
    model.answer = lambda lines: [tidy(line) for line in lines[:-1]]  # a line lost
    client.post(f"/api/sessions/{SID}", json=meeting())
    done(server)
    copy = client.get(f"/api/sessions/{SID}?cleaned=true").json()["cleaned"]["copy"]
    assert copy["keptRaw"] == 3
    assert [x["text"] for x in copy["lines"]] == [
        s["text"] for s in meeting()["segments"]
    ]


def test_a_failure_is_reported_and_keeps_the_last_copy(server, model, client):
    client.post(f"/api/sessions/{SID}", json=meeting())
    done(server)
    model.fail = True
    assert client.post(f"/api/sessions/{SID}/clean", json={}).status_code == 202
    run = done(server)
    assert run["status"] == "failed" and "500" in run["error"]
    got = client.get(f"/api/sessions/{SID}").json()
    assert got["cleaned"]["available"] and got["cleaned"]["run"]["status"] == "failed"
    assert got["session"]["segments"][0]["text"] == "um so the the cost is fine"


def test_a_changed_transcript_makes_the_copy_stale(server, model, client, monkeypatch):
    client.post(f"/api/sessions/{SID}", json=meeting())
    done(server)
    monkeypatch.setattr(server, "CLEANUP_AUTO", False)
    changed = meeting()
    changed["segments"][0]["text"] = "something else"
    client.post(f"/api/sessions/{SID}", json=changed)
    assert client.get(f"/api/sessions/{SID}").json()["cleaned"]["copy"]["stale"]


def test_a_run_cut_short_by_a_restart_reads_as_failed(server, model, client):
    client.post(f"/api/sessions/{SID}", json=meeting())
    done(server)
    server._write_json(
        server.RECORDINGS / SID / "cleaning.json", {"status": "running", "chunks": 3}
    )
    server._JOBS.clear()
    assert server._cleaning(SID)["status"] == "failed"


def test_clean_route_checks(server, model, client):
    assert client.post(f"/api/sessions/{SID}/clean", json={}).status_code == 404
    client.post(f"/api/sessions/{SID}", json=meeting())
    assert client.post(f"/api/sessions/{SID}/clean", content=b"{}").status_code == 415
    assert client.post("/api/sessions/nope/clean", json={}).status_code == 404


# --- MCP ---------------------------------------------------------------------


def test_mcp_returns_raw_by_default_and_cleaned_on_request(server, model, client, mcp):
    model.answer = lambda lines: [tidy(line).replace("two", "20") for line in lines]
    client.post(f"/api/sessions/{SID}", json=meeting())
    done(server)
    raw = mcp["get_transcript"](SID).splitlines()
    assert raw[3:] == [
        "[0:00] Ada: um so the the cost is fine",
        "[0:05] Grace: so that's two off the price",
        "[0:09] Ada: um",
    ]
    cleaned = mcp["get_transcript"](SID, cleaned=True).splitlines()
    assert "1 line(s) kept as spoken" in cleaned[2]
    assert cleaned[4:] == [
        "[0:00] Ada: So the the cost is fine.",
        "[0:05] Grace: so that's two off the price (as spoken)",
        "[0:09] Ada:",
    ]
    [listed] = mcp["list_meetings"]()
    assert listed["cleaned"] == {
        "available": True,
        "keptRaw": 1,
        "run": {"status": "done", "chunksDone": 1, "chunks": 1, "error": None},
    }
