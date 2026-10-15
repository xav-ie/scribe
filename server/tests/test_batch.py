"""/v1/audio/transcriptions: the OpenAI-style batch endpoint."""

import io
import json

import numpy as np
import pytest
import soundfile as sf
from conftest import STEP, FakeState


def wav(seconds=0.25, rate=16000, channels=1):
    buf = io.BytesIO()
    data = np.zeros((int(seconds * rate), channels), dtype=np.int16)
    sf.write(buf, data, rate, format="WAV")
    return buf.getvalue()


def post(client, body):
    return client.post(
        "/v1/audio/transcriptions",
        files={"file": ("clip.wav", body, "audio/wav")},
        data={"model": "ignored"},
    )


def test_a_clip_is_decoded_in_steps_with_the_vocabulary(client, server):
    server.VOCAB.write_text(json.dumps(["NeMo"]))
    r = post(client, wav(seconds=0.25))
    assert r.status_code == 200 and r.json() == {"text": "w1 w2 w3"}
    state = FakeState.instances[0]
    assert state.steps == [(STEP, False), (STEP, False), (800, True)]
    assert state.boost == ["NeMo"] and state.closed


def test_stereo_and_other_rates_are_downmixed_and_resampled(client):
    assert post(client, wav(seconds=0.1, rate=48000, channels=2)).status_code == 200
    assert FakeState.instances[0].steps == [(STEP, True)]


def test_empty_clip(client):
    assert post(client, wav(seconds=0)).json() == {"text": ""}


@pytest.mark.parametrize(
    ("body", "status"),
    [(b"not audio", 400), (wav(rate=1000003), 400)],
)
def test_bad_clips_are_refused(client, body, status):
    assert post(client, body).status_code == status
    assert FakeState.instances == []


def test_long_and_large_clips_are_refused(client, server, monkeypatch):
    monkeypatch.setattr(server, "MAX_CLIP_S", 0.1)
    assert post(client, wav(seconds=0.2)).status_code == 413
    monkeypatch.setattr(server, "MAX_UPLOAD_BYTES", 100)
    assert post(client, wav(seconds=0.05)).status_code == 413
