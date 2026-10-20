"""SCRIBE_WYOMING: the Wyoming speech-to-text server Home Assistant talks to."""

import asyncio
import json

import numpy as np
from conftest import STEP, FakeState


def event(kind, data=None, payload=b""):
    # Data after the header line, as the wyoming library sends it.
    body = json.dumps(data or {}).encode()
    header = {"type": kind, "data_length": len(body), "payload_length": len(payload)}
    return json.dumps(header).encode() + b"\n" + body + payload


def talk(server, *events):
    """Send events to one connection and return every event it answers with."""

    async def run():
        listener = await asyncio.start_server(server._wyoming_client, "127.0.0.1", 0)
        async with listener:
            port = listener.sockets[0].getsockname()[1]
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(b"".join(events))
            writer.write_eof()
            replies = [json.loads(line) for line in (await reader.read()).splitlines()]
            writer.close()
            return replies

    return asyncio.run(run())


def audio(seconds, rate=16000, channels=1):
    fmt = {"rate": rate, "width": 2, "channels": channels}
    samples = np.zeros(int(seconds * rate) * channels, dtype=np.int16).tobytes()
    return [
        event("audio-start", fmt),
        event("audio-chunk", fmt, samples[: len(samples) // 2]),
        event("audio-chunk", fmt, samples[len(samples) // 2 :]),
        event("audio-stop"),
    ]


def test_describe_lists_the_model(server):
    [info] = talk(server, event("describe"))
    assert info["type"] == "info"
    [asr] = info["data"]["asr"]
    assert asr["installed"] and asr["models"][0]["languages"] == ["en"]


def test_audio_is_transcribed_with_the_vocabulary(server):
    server.VOCAB.write_text(json.dumps(["NeMo"]))
    replies = talk(server, event("transcribe", {"language": "en"}), *audio(0.25))
    assert replies == [{"type": "transcript", "data": {"text": "w1 w2 w3"}}]
    [state] = FakeState.instances
    assert state.steps == [(STEP, False), (STEP, False), (800, True)]
    assert state.boost == ["NeMo"] and state.closed


def test_stereo_and_other_rates_are_downmixed_and_resampled(server):
    talk(server, *audio(0.1, rate=48000, channels=2))
    assert FakeState.instances[0].steps == [(STEP, True)]


def test_silence_is_an_empty_transcript(server):
    fmt = {"rate": 16000, "width": 2, "channels": 1}
    replies = talk(server, event("audio-start", fmt), event("audio-stop"))
    assert replies == [{"type": "transcript", "data": {"text": ""}}]
    assert FakeState.instances == []


def test_bad_input_drops_the_connection(server, monkeypatch):
    assert talk(server, b"not json\n", event("describe")) == []
    bad_rate = {"rate": 1000003, "width": 2, "channels": 1}
    assert talk(server, event("audio-start", bad_rate), event("audio-stop")) == []
    monkeypatch.setattr(server, "MAX_CLIP_S", 0.1)
    assert talk(server, *audio(0.2)) == []
    assert FakeState.instances == []
