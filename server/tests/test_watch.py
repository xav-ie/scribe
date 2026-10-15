"""/ws/watch: a watcher's view mirrors the streams' own clients."""

import json

from conftest import SID, FakeState, pcm, settle
from test_ws import apply, hello


def test_watcher_gets_snapshot_then_the_same_updates(client, server):
    with client.websocket_connect("/ws") as stream:
        stream.send_text(hello(sessionId=SID, channel="tab"))
        stream.send_bytes(pcm())
        first = json.loads(stream.receive_text())
        listing = client.get("/api/sessions").json()
        assert [s for s in listing if s["sessionId"] == SID and s["live"]]
        assert client.get(f"/api/sessions/{SID}").json()["live"] is True

        with client.websocket_connect(f"/ws/watch/{SID}") as w:
            snap = json.loads(w.receive_text())
            assert snap["from"] == 0 and snap["channel"] == "tab"
            assert snap["words"] == first["words"]
            stream.send_bytes(pcm())
            update = json.loads(stream.receive_text())
            seen = json.loads(w.receive_text())
            assert {k: seen[k] for k in ("type", "from", "words")} == update
            words = apply(list(snap["words"]), seen)
            assert [x["word"] for x in words] == ["w1", "w2"]
            stream.close()
            closed = json.loads(w.receive_text())
            assert closed == {"type": "closed", "stream": snap["stream"]}
    settle(lambda: SID not in server.LIVE and SID not in server.WATCHERS)


def test_two_streams_are_told_apart(client):
    with (
        client.websocket_connect("/ws") as tab,
        client.websocket_connect("/ws") as mic,
    ):
        tab.send_text(hello(sessionId=SID, channel="tab"))
        mic.send_text(hello(sessionId=SID, channel="mic"))
        tab.send_bytes(pcm())
        tab.receive_text()
        mic.send_bytes(pcm())
        mic.receive_text()
        with client.websocket_connect(f"/ws/watch/{SID}") as w:
            snaps = [json.loads(w.receive_text()) for _ in range(2)]
            assert sorted(s["channel"] for s in snaps) == ["mic", "tab"]
            assert len({s["stream"] for s in snaps}) == 2


def test_watching_an_idle_session_says_so(client, server):
    with client.websocket_connect(f"/ws/watch/{SID}") as w:
        assert json.loads(w.receive_text()) == {"type": "idle"}
    settle(lambda: SID not in server.WATCHERS)


def test_closed_watchers_are_forgotten(client, server):
    with client.websocket_connect("/ws") as stream:
        stream.send_text(hello(sessionId=SID, channel="tab"))
        with client.websocket_connect(f"/ws/watch/{SID}") as a:
            with client.websocket_connect(f"/ws/watch/{SID}"):
                settle(lambda: len(server.WATCHERS.get(SID, ())) == 2)
            settle(lambda: len(server.WATCHERS[SID]) == 1)
            stream.send_bytes(pcm())
            stream.receive_text()
            assert json.loads(a.receive_text())["type"] == "words"
        settle(lambda: SID not in server.WATCHERS)


def test_streams_without_a_session_id_are_not_live(client, server):
    with client.websocket_connect("/ws") as stream:
        stream.send_text(hello(sessionId="nope", channel="tab"))
        stream.send_bytes(pcm())
        stream.receive_text()
        assert server.LIVE == {}


def test_closed_comes_after_the_recording_is_complete(client, server):
    with client.websocket_connect(f"/ws/watch/{SID}") as w:
        assert json.loads(w.receive_text()) == {"type": "idle"}
        with client.websocket_connect("/ws") as stream:
            stream.send_text(hello(sessionId=SID, channel="tab", save=True))
            stream.send_bytes(pcm())
            stream.receive_text()
            assert json.loads(w.receive_text())["type"] == "words"
        assert json.loads(w.receive_text())["type"] == "closed"
        meta = json.loads((server.RECORDINGS / SID / "tab.json").read_text())
        assert [x["word"] for x in meta["words"]] == ["w1"]


def test_a_failed_save_still_frees_the_stream(client, server, monkeypatch):
    def full_disk(self, words, tail):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(server.Recording, "close", full_disk)
    with client.websocket_connect(f"/ws/watch/{SID}") as w:
        w.receive_text()
        with client.websocket_connect("/ws") as stream:
            stream.send_text(hello(sessionId=SID, channel="tab", save=True))
        assert json.loads(w.receive_text())["type"] == "closed"
    settle(lambda: FakeState.instances[0].closed)
