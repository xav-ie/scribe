"""/ws: the word-delta protocol, end of stream, saving, boosting, bad input."""

import json

import pytest
import soundfile as sf
from conftest import SID, STEP, FakeState, pcm, settle
from starlette.websockets import WebSocketDisconnect


def hello(**extra):
    return json.dumps({"sampleRate": 16000, **extra})


def apply(words, update):
    """What every client does with an update: replace from `from` on."""
    assert update["type"] == "words"
    assert 0 <= update["from"] <= len(words)
    words[update["from"] :] = update["words"]
    return words


def test_updates_resend_only_the_last_word(client):
    FakeState.script = [["hel"], ["hello", "wor"], ["hello", "world", "again"]]
    updates = []
    with client.websocket_connect("/ws") as ws:
        ws.send_text(hello())
        for _ in range(3):
            ws.send_bytes(pcm())
            updates.append(json.loads(ws.receive_text()))
    assert [(u["from"], [w["word"] for w in u["words"]]) for u in updates] == [
        (0, ["hel"]),
        (0, ["hello", "wor"]),
        (1, ["world", "again"]),
    ]
    words = []
    for u in updates:
        apply(words, u)
    assert [w["word"] for w in words] == ["hello", "world", "again"]


def test_small_messages_are_buffered_into_whole_steps(client):
    with client.websocket_connect("/ws") as ws:
        ws.send_text(hello())
        ws.send_bytes(pcm(STEP // 2))
        ws.send_bytes(pcm(STEP // 2 + 10))
        json.loads(ws.receive_text())
        ws.send_text(json.dumps({"type": "end"}))
        json.loads(ws.receive_text())
        assert json.loads(ws.receive_text()) == {"type": "done"}
    state = FakeState.instances[0]
    assert state.steps == [(STEP, False), (10, True)]


def test_source_rate_is_resampled_per_step(client):
    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"sampleRate": 48000}))
        ws.send_bytes(pcm(STEP * 3))
        json.loads(ws.receive_text())
    assert FakeState.instances[0].steps[0] == (STEP, False)


def test_end_with_nothing_pending_still_flushes(client):
    with client.websocket_connect("/ws") as ws:
        ws.send_text(hello())
        ws.send_text(json.dumps({"type": "end"}))
        final = json.loads(ws.receive_text())
        assert final["type"] == "words" and final["from"] == 0
        assert json.loads(ws.receive_text()) == {"type": "done"}
    state = FakeState.instances[0]
    assert state.steps == [(1, True)]
    settle(lambda: state.closed)


@pytest.mark.parametrize("rate", [0, -48000, "x", None, 10**9, 1000003, 191999])
def test_bad_sample_rate_closes_the_stream(client, rate):
    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"sampleRate": rate}))
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
    assert closed.value.code == 1003
    assert FakeState.instances[0].steps == []


@pytest.mark.parametrize("text", ["not json", "[1, 2]", '"sampleRate"'])
def test_non_object_config_closes_the_stream(client, text):
    with client.websocket_connect("/ws") as ws:
        ws.send_text(text)
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
    assert closed.value.code == 1003


def test_saved_stream_writes_audio_and_words(client, server):
    with client.websocket_connect("/ws") as ws:
        ws.send_text(hello(sessionId=SID, channel="tab", save=True, boost=["Ada"]))
        ws.send_text(json.dumps({"epoch": 1234}))
        ws.send_bytes(pcm(STEP + 100))
        json.loads(ws.receive_text())
    folder = server.RECORDINGS / SID
    settle((folder / "tab.json").exists)
    meta = json.loads((folder / "tab.json").read_text())
    assert meta["channel"] == "tab" and meta["epoch"] == 1234
    assert meta["boost"] == ["Ada"]
    assert [w["word"] for w in meta["words"]] == ["w1"]
    # The tail short of a step is kept too.
    assert sf.info(folder / "tab.flac").frames == STEP + 100


def test_a_reopened_channel_keeps_the_earlier_stream(client, server):
    for n in (1, 2):
        with client.websocket_connect("/ws") as ws:
            ws.send_text(hello(sessionId=SID, channel="mic", save=True))
            ws.send_bytes(pcm())
            json.loads(ws.receive_text())
        settle(lambda n=n: len(list((server.RECORDINGS / SID).glob("*.json"))) == n)
    names = sorted(p.name for p in (server.RECORDINGS / SID).iterdir())
    assert names == ["mic-2.flac", "mic-2.json", "mic.flac", "mic.json"]


def test_stream_without_audio_keeps_only_metadata(client, server):
    with client.websocket_connect("/ws") as ws:
        ws.send_text(hello(sessionId=SID, channel="tab", save=True))
    settle((server.RECORDINGS / SID / "tab.json").exists)
    assert [p.name for p in (server.RECORDINGS / SID).iterdir()] == ["tab.json"]


@pytest.mark.parametrize(
    "config",
    [
        {"sessionId": SID, "channel": "tab", "save": False},
        {"sessionId": "../../etc", "channel": "tab", "save": True},
        {"sessionId": SID, "channel": "../x", "save": True},
    ],
)
def test_nothing_is_saved_unless_asked_with_valid_names(client, server, config):
    with client.websocket_connect("/ws") as ws:
        ws.send_text(hello(**config))
        ws.send_bytes(pcm())
        json.loads(ws.receive_text())
    assert not server.RECORDINGS.exists()


def test_boost_is_vocabulary_plus_names_and_first_names(client, server):
    server.VOCAB.write_text(json.dumps(["Parakeet", "NeMo"]))
    with client.websocket_connect("/ws") as ws:
        ws.send_text(
            hello(boost=["Ada Lovelace", "  Grace   Hopper ", "Ada Lovelace", 7])
        )
    state = FakeState.instances[0]
    assert state.boost == [
        "Parakeet",
        "NeMo",
        "Ada Lovelace",
        "Grace Hopper",
        "Ada",
        "Grace",
    ]
    settle(lambda: state.closed)


def test_no_boost_without_phrases(client):
    with client.websocket_connect("/ws") as ws:
        ws.send_text(hello())
    assert FakeState.instances[0].boost is None


@pytest.mark.parametrize("rate", [8000, 44100, 48000, 96000])
def test_common_rates_are_accepted(client, rate):
    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"sampleRate": rate}))
        ws.send_bytes(pcm(rate // 10))
        assert json.loads(ws.receive_text())["type"] == "words"


def test_the_first_sample_rate_holds(client):
    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"sampleRate": 48000}))
        ws.send_text(json.dumps({"sampleRate": 1000003}))
        ws.send_bytes(pcm(STEP * 3))
        json.loads(ws.receive_text())
    assert FakeState.instances[0].steps == [(STEP, False)]


def test_end_is_honoured_once(client):
    with client.websocket_connect("/ws") as ws:
        ws.send_text(hello())
        ws.send_text(json.dumps({"type": "end"}))
        ws.send_text(json.dumps({"type": "end"}))
        ws.send_bytes(pcm(STEP * 2))
        json.loads(ws.receive_text())
        assert json.loads(ws.receive_text()) == {"type": "done"}
        ws.send_text(hello())
    state = FakeState.instances[0]
    settle(lambda: state.closed)
    assert state.steps == [(1, True)]


def test_half_samples_close_the_stream(client):
    with client.websocket_connect("/ws") as ws:
        ws.send_text(hello())
        ws.send_bytes(b"\x00\x00\x00")
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
    assert closed.value.code == 1003


def test_a_stream_too_far_ahead_is_cut_off(client, server, monkeypatch):
    monkeypatch.setattr(server, "MAX_BACKLOG_S", 0.05)
    with client.websocket_connect("/ws") as ws:
        ws.send_text(hello())
        ws.send_bytes(pcm(STEP * 4))
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
    assert closed.value.code == 1013
