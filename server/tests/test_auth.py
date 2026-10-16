"""The access token: loading it, and every route and socket asking for it."""

import json

import pytest
from conftest import SID, FakeState, pcm
from starlette.websockets import WebSocketDisconnect

TOKEN = "s3cret-token"
BEARER = {"authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def locked(server, monkeypatch):
    monkeypatch.setattr(server, "TOKEN", TOKEN)
    return server


def test_token_file_is_preferred_and_trimmed(server, tmp_path):
    f = tmp_path / "token"
    f.write_text(f"{TOKEN}\n")
    assert server._load_token({"SCRIBE_TOKEN_FILE": str(f)}) == TOKEN
    assert server._load_token({"SCRIBE_TOKEN": TOKEN}) == TOKEN
    assert server._load_token({}) is None


@pytest.mark.parametrize("env", ["both", "empty file"])
def test_bad_token_settings_stop_the_server(server, tmp_path, env):
    f = tmp_path / "token"
    f.write_text("" if env == "empty file" else TOKEN)
    environ = {"SCRIBE_TOKEN_FILE": str(f)}
    if env == "both":
        environ["SCRIBE_TOKEN"] = TOKEN
    with pytest.raises(RuntimeError):
        server._load_token(environ)


def test_info_says_whether_a_token_is_needed(client, server, monkeypatch):
    assert client.get("/api/info").json() == {"auth": False}
    monkeypatch.setattr(server, "TOKEN", TOKEN)
    assert client.get("/api/info").json() == {"auth": True}


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/sessions"),
        ("get", f"/api/sessions/{SID}"),
        ("post", f"/api/sessions/{SID}"),
        ("get", "/api/vocab"),
        ("put", "/api/vocab"),
        ("get", f"/api/sessions/{SID}/audio/tab"),
        ("get", "/api/pairing"),
        ("post", "/v1/audio/transcriptions"),
        ("post", "/mcp"),
    ],
)
def test_routes_refuse_requests_without_the_token(client, locked, method, path):
    r = getattr(client, method)(path)
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == "Bearer"
    r = getattr(client, method)(path, headers={"authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_the_page_and_health_stay_open(client, locked):
    assert client.get("/").status_code == 200
    assert client.get("/health").status_code == 200


def test_bearer_token_works(client, locked):
    assert client.get("/api/sessions", headers=BEARER).status_code == 200


def test_login_sets_a_cookie_that_works(client, locked):
    assert client.post("/api/login", json={"token": "wrong"}).status_code == 401
    r = client.post("/api/login", json={"token": TOKEN})
    assert r.status_code == 200
    cookie = r.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie
    assert client.get("/api/sessions").status_code == 200
    client.post("/api/logout")
    assert client.get("/api/sessions").status_code == 401


def test_login_needs_a_token_to_exist(client):
    assert client.post("/api/login", json={"token": ""}).status_code == 401


def test_pairing_url_carries_the_token(client, locked):
    url = client.get("/api/pairing", headers=BEARER).json()["url"]
    assert url == f"ws://testserver/ws#token={TOKEN}"
    forwarded = BEARER | {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "s.example.com",
    }
    url = client.get("/api/pairing", headers=forwarded).json()["url"]
    assert url == f"wss://s.example.com/ws#token={TOKEN}"


def test_stream_needs_the_token_in_its_first_message(client, locked):
    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"sampleRate": 16000}))
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
    assert closed.value.code == 1008
    with client.websocket_connect("/ws") as ws:
        ws.send_bytes(pcm())
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
    assert closed.value.code == 1008
    assert all(s.steps == [] for s in FakeState.instances)


def test_stream_with_the_token(client, locked):
    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"sampleRate": 16000, "token": TOKEN}))
        ws.send_bytes(pcm())
        assert json.loads(ws.receive_text())["type"] == "words"
    with client.websocket_connect("/ws", headers=BEARER) as ws:
        ws.send_text(json.dumps({"sampleRate": 16000}))
        ws.send_bytes(pcm())
        assert json.loads(ws.receive_text())["type"] == "words"


def test_watching_needs_the_cookie_or_token(client, locked):
    with (
        pytest.raises(WebSocketDisconnect) as refused,
        client.websocket_connect(f"/ws/watch/{SID}"),
    ):
        pass
    assert refused.value.code == 1008
    client.post("/api/login", json={"token": TOKEN})
    with client.websocket_connect(f"/ws/watch/{SID}") as w:
        assert json.loads(w.receive_text()) == {"type": "idle"}
