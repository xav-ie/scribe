"""Cross-site and DNS rebinding protections."""

import importlib
import json

import pytest
from conftest import SID, pcm
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketDenialResponse
from starlette.websockets import WebSocketDisconnect


@pytest.mark.parametrize("path", ["/ws", f"/ws/watch/{SID}"])
def test_other_sites_cannot_open_sockets(client, path):
    evil = {"origin": "https://evil.example"}
    with (
        pytest.raises(WebSocketDisconnect) as closed,
        client.websocket_connect(path, headers=evil),
    ):
        pass
    assert closed.value.code == 1008


@pytest.mark.parametrize(
    "origin",
    [
        None,
        "http://testserver",
        "https://testserver:8443",
        "chrome-extension://abcdefghijklmnop",
    ],
)
def test_same_site_extensions_and_apps_can(client, origin):
    headers = {"origin": origin} if origin else {}
    with client.websocket_connect("/ws", headers=headers) as ws:
        ws.send_text(json.dumps({"sampleRate": 16000}))
        ws.send_bytes(pcm())
        assert json.loads(ws.receive_text())["type"] == "words"


@pytest.fixture
def pinned(monkeypatch, tmp_path):
    """stream_server re-imported with SCRIBE_ALLOWED_HOSTS set."""
    import stream_server

    monkeypatch.setenv("SCRIBE_ALLOWED_HOSTS", "scribe.example.com,localhost")
    monkeypatch.setenv("SCRIBE_RECORDINGS", str(tmp_path))
    yield importlib.reload(stream_server)
    monkeypatch.delenv("SCRIBE_ALLOWED_HOSTS")
    importlib.reload(stream_server)


def test_allowed_hosts_refuse_other_names(pinned):
    with TestClient(pinned.app, base_url="http://scribe.example.com") as ok:
        assert ok.get("/api/sessions").status_code == 200
    with TestClient(pinned.app, base_url="http://localhost:8000") as ok:
        assert ok.get("/api/sessions").status_code == 200
    with TestClient(pinned.app, base_url="http://rebound.evil.example") as bad:
        assert bad.get("/api/sessions").status_code == 400
        rebound = {"host": "rebound.evil.example"}
        with (
            pytest.raises(WebSocketDenialResponse),
            bad.websocket_connect("/ws", headers=rebound),
        ):
            pass
    local = {"host": "localhost:8000"}
    with TestClient(pinned.app) as ok, ok.websocket_connect("/ws", headers=local) as ws:
        ws.send_text(json.dumps({"sampleRate": 16000}))


def test_a_page_on_an_allowed_host_passes_a_rewritten_host(pinned):
    with TestClient(pinned.app, base_url="http://localhost:8000") as c:
        # TestClient sends Host: testserver on sockets unless told otherwise.
        page = {"origin": "https://scribe.example.com", "host": "localhost:8000"}
        with c.websocket_connect("/ws", headers=page) as ws:
            ws.send_text(json.dumps({"sampleRate": 16000}))
