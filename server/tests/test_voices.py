"""Voice correction: speakers re-checked against their voices in the tab audio.

The speaker model is stubbed: each speaker's speech is a constant level in the
audio, and a clip's voiceprint is how much of it is each level, so a window
across two speakers gets a blend of both, as real voiceprints do.
"""

import time

import numpy as np
import pytest
import soundfile as sf
from conftest import SID, settle
from test_sessions import JSON

EPOCH = 1_700_000_000_000
LEVELS = {"Ada": 0.1, "Grace": 0.3}
TRUE_CHANGE_S = 21.0  # Grace really starts here
TIMELINE_CHANGE_S = 24.5  # the indicator only catches up here


def stub_embed(clips):
    out = []
    for clip in clips:
        clip = np.asarray(clip)
        v = np.array(
            [
                *(
                    np.isclose(clip, level, atol=0.01).sum()
                    for level in LEVELS.values()
                ),
                1.0,
            ]
        )
        out.append(v / np.linalg.norm(v))
    return out


def words():
    """Runs of 8 words, 0.3 s apart, with a pause every 3 s; 40 s in all."""
    return [
        {
            "word": f"w{run}_{i}",
            "start": run * 3 + i * 0.3,
            "end": run * 3 + i * 0.3 + 0.25,
        }
        for run in range(14)
        for i in range(8)
    ]


def audio(ws):
    samples = np.zeros(43 * 16000, dtype=np.float32)
    for w in ws:
        level = LEVELS["Ada" if w["start"] < TRUE_CHANGE_S else "Grace"]
        samples[int(w["start"] * 16000) : int(w["end"] * 16000)] = level
    return samples


def make_session(server, change_s=TIMELINE_CHANGE_S, **extra):
    ws = words()
    timeline = [
        {"name": "Ada", "from": EPOCH - 1000},
        {"name": "Grace", "from": EPOCH + change_s * 1000},
    ]
    labelled = [
        (
            EPOCH + (w["start"] + w["end"]) / 2 * 1000,
            server._speaker_at(
                timeline, EPOCH + (w["start"] + w["end"]) / 2 * 1000 + server.LEAD_MS
            ),
            w["word"],
        )
        for w in ws
    ]
    record = {
        "startedAt": EPOCH,
        "stoppedAt": EPOCH + 43_000,
        "platform": "meet",
        "timeline": timeline,
        "tab": [{"words": ws, "epoch": EPOCH}],
        "mic": [
            {"words": [{"word": "hello", "start": 30.0, "end": 30.2}], "epoch": EPOCH}
        ],
        "segments": server._merge_words(
            labelled,
            [
                {
                    "words": [{"word": "hello", "start": 30.0, "end": 30.2}],
                    "epoch": EPOCH,
                }
            ],
        ),
        **extra,
    }
    folder = server.RECORDINGS / SID
    folder.mkdir(parents=True, exist_ok=True)
    sf.write(folder / "tab.flac", audio(ws), 16000)
    server._write_json(
        folder / "tab.json", {"channel": "tab", "epoch": EPOCH, "words": ws}
    )
    return record


@pytest.fixture
def voices(server, monkeypatch):
    monkeypatch.setattr(server, "_embed", stub_embed)
    monkeypatch.setattr(server, "_VOICE_JOBS", {})
    return server


def finished(server):
    def done():
        run = server._voicing(SID)
        return run and run["status"] in ("done", "failed")

    settle(done, timeout=10)
    return server._voicing(SID)


def speaker_of(segments, word):
    return next(s["speaker"] for s in segments if word in s["text"].split())


def test_a_late_speaker_change_is_corrected_by_voice(voices, client):
    record = make_session(voices, voices=True, saveAudio=True)
    client.post(f"/api/sessions/{SID}", json=record)
    assert finished(voices)["status"] == "done"
    got = client.get(f"/api/sessions/{SID}").json()
    session = got["session"]
    # Grace's first run (21-23.4 s) was the timeline's Ada; the voice moves it.
    assert speaker_of(session["timelineSegments"], "w7_0") == "Ada"
    assert speaker_of(session["segments"], "w7_0") == "Grace"
    # Speech well inside each turn stays where it was, and the mic is untouched.
    assert speaker_of(session["segments"], "w2_3") == "Ada"
    assert speaker_of(session["segments"], "w12_3") == "Grace"
    assert speaker_of(session["segments"], "hello") == "Me"
    assert session["voices"]["changed"] == 8
    assert {(c["from"], c["to"]) for c in session["voices"]["changes"]} == {
        ("Ada", "Grace")
    }
    assert got["voicesRun"]["status"] == "done"
    assert (voices.RECORDINGS / SID / "tab.flac").exists()


def test_a_right_timeline_is_left_alone(voices, client):
    # Switching at 21.5 s: with the 0.9 s lead, every word lands on its speaker.
    record = make_session(voices, change_s=TRUE_CHANGE_S + 0.5, voices=True)
    client.post(f"/api/sessions/{SID}", json=record)
    assert finished(voices)["status"] == "done"
    session = client.get(f"/api/sessions/{SID}").json()["session"]
    assert session["voices"]["changed"] == 0
    assert session["segments"] == session["timelineSegments"]


def test_audio_kept_only_for_this_is_dropped_after(voices, client):
    client.post(
        f"/api/sessions/{SID}", json=make_session(voices, voices=True, saveAudio=False)
    )
    assert finished(voices)["status"] == "done"
    folder = voices.RECORDINGS / SID
    assert not (folder / "tab.flac").exists()
    assert (folder / "tab.json").exists() and (folder / "voices.json").exists()
    # The corrected transcript outlives the audio.
    session = client.get(f"/api/sessions/{SID}").json()["session"]
    assert speaker_of(session["segments"], "w7_0") == "Grace"


def test_without_the_flag_nothing_runs(voices, client):
    client.post(f"/api/sessions/{SID}", json=make_session(voices))
    assert voices._voicing(SID) is None
    assert "voices" not in client.get(f"/api/sessions/{SID}").json()["session"]


def test_a_newer_record_sets_the_correction_aside(voices, client):
    record = make_session(voices, voices=True)
    client.post(f"/api/sessions/{SID}", json=record)
    finished(voices)
    record["segments"] = record["segments"][:3]
    del record["voices"]
    client.post(f"/api/sessions/{SID}", json=record)
    session = client.get(f"/api/sessions/{SID}").json()["session"]
    assert "voices" not in session and len(session["segments"]) == 3


def test_cleanup_follows_the_correction(voices, client, monkeypatch):
    started = []
    monkeypatch.setattr(voices, "CLEANUP_URL", "http://cleanup.invalid/v1")
    monkeypatch.setattr(voices, "CLEANUP_AUTO", True)
    # Cleanup reads the transcript as it stands when it starts.
    monkeypatch.setattr(
        voices,
        "_start_cleanup",
        lambda sid: started.append(
            "voices" in voices._read_session(voices.RECORDINGS / sid)
        ),
    )
    client.post(f"/api/sessions/{SID}", json=make_session(voices, voices=True))
    finished(voices)
    settle(lambda: started)
    assert started == [True]


def test_the_route_runs_it_on_request(voices, client):
    client.post(f"/api/sessions/{SID}", json=make_session(voices))
    r = client.post(f"/api/sessions/{SID}/voices", headers=JSON, content="{}")
    assert r.status_code == 202
    assert finished(voices)["status"] == "done"
    assert (
        client.get(f"/api/sessions/{SID}").json()["session"]["voices"]["changed"] == 8
    )


def test_route_checks(voices, client):
    assert (
        client.post(
            f"/api/sessions/{SID}/voices", headers=JSON, content="{}"
        ).status_code
        == 404
    )
    client.post(f"/api/sessions/{SID}", json=make_session(voices))
    assert client.post(f"/api/sessions/{SID}/voices", content="{}").status_code == 415
    (voices.RECORDINGS / SID / "tab.flac").unlink()
    assert (
        client.post(
            f"/api/sessions/{SID}/voices", headers=JSON, content="{}"
        ).status_code
        == 409
    )


def test_mcp_corrects_and_the_transcript_reads_it(voices, client, mcp):
    client.post(f"/api/sessions/{SID}", json=make_session(voices))
    assert mcp["correct_speakers"](SID)["status"] in ("queued", "running", "done")
    finished(voices)
    text = mcp["get_transcript"](SID)
    assert "Grace: w7_0 w7_1" in text and "Ada: w7_0" not in text


def test_a_failure_is_reported(voices, client, monkeypatch):
    def broken(clips):
        raise RuntimeError("model unavailable")

    monkeypatch.setattr(voices, "_embed", broken)
    started = []
    monkeypatch.setattr(voices, "CLEANUP_URL", "http://cleanup.invalid/v1")
    monkeypatch.setattr(voices, "_start_cleanup", started.append)
    client.post(
        f"/api/sessions/{SID}", json=make_session(voices, voices=True, saveAudio=False)
    )
    run = finished(voices)
    assert run["status"] == "failed" and "model unavailable" in run["error"]
    # Nothing was corrected, so the audio stays for another try.
    assert (voices.RECORDINGS / SID / "tab.flac").exists()
    # ...and the transcript is as it was, so cleanup has nothing new to do.
    time.sleep(0.2)
    assert started == []
