#!/usr/bin/env python3
"""Live fan-out check without a GPU: the ML stack and the MCP SDK are stubbed,
StreamState is a fake that emits one word per step. Run by `nix flake check`."""

import importlib
import json
import sys
import types
from unittest.mock import MagicMock

import scipy.signal  # noqa: F401  before the torch stub: scipy probes sys.modules["torch"]
from starlette.applications import Starlette


class AnyMod(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return MagicMock(name=f"{self.__name__}.{name}")


for m in [
    "nemo",
    "nemo.collections",
    "nemo.collections.asr",
    "nemo.collections.asr.parts",
    "nemo.collections.asr.parts.context_biasing",
    "nemo.collections.asr.parts.context_biasing.biasing_multi_model",
    "nemo.collections.asr.parts.context_biasing.boosting_graph_batched",
    "nemo.collections.asr.parts.submodules",
    "nemo.collections.asr.parts.submodules.rnnt_decoding",
    "nemo.collections.asr.parts.utils",
    "nemo.collections.asr.parts.utils.streaming_utils",
    "nemo.utils",
    "torch",
    "omegaconf",
    "mcp",
    "mcp.server",
    "mcp.server.mcpserver",
    "mcp.server.mcpserver.exceptions",
    "mcp.server.transport_security",
]:
    sys.modules[m] = AnyMod(m)


class FakeMCP:
    def __init__(self, *a, **k):
        pass

    def tool(self, *a, **k):
        return lambda f: f

    def streamable_http_app(self, *a, **k):
        return Starlette()


sys.modules["mcp.server.mcpserver"].MCPServer = FakeMCP
sys.modules["mcp.server.mcpserver.exceptions"].ToolError = type(
    "ToolError", (Exception,), {}
)

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
srv = importlib.import_module("stream_server")


class FakeState:
    def __init__(self):
        import numpy as np

        self.words, self.pending, self.n = [], np.empty(0, dtype=np.float32), 0

    def set_boost(self, p):
        pass

    def step_size(self):
        return 1600

    def step(self, audio, last=False):
        self.n += 1
        self.words.append({"word": f"w{self.n}", "start": self.n, "end": self.n})

    def close(self):
        pass


srv.StreamState = FakeState

import numpy as np
from fastapi.testclient import TestClient

c = TestClient(srv.app)
sid = "11111111-2222-3333-4444-555555555555"
pcm = np.zeros(1600, dtype=np.int16).tobytes()
with c.websocket_connect("/ws") as client:
    client.send_text(
        json.dumps(
            {"sampleRate": 16000, "sessionId": sid, "channel": "tab", "save": False}
        )
    )
    client.send_bytes(pcm)
    a = json.loads(client.receive_text())
    assert a == {
        "type": "words",
        "from": 0,
        "words": [{"word": "w1", "start": 1, "end": 1}],
    }, a
    listing = c.get("/api/sessions").json()
    assert [s for s in listing if s["sessionId"] == sid and s["live"]], listing
    assert c.get(f"/api/sessions/{sid}").json()["live"] is True
    with c.websocket_connect(f"/ws/watch/{sid}") as w:
        snap = json.loads(w.receive_text())
        assert (
            snap["from"] == 0
            and [x["word"] for x in snap["words"]] == ["w1"]
            and snap["channel"] == "tab"
        ), snap
        client.send_bytes(pcm)
        b = json.loads(client.receive_text())
        wb = json.loads(w.receive_text())
        assert {k: wb[k] for k in ("type", "from", "words")} == b, (wb, b)
        words = snap["words"]
        words[wb["from"] :] = wb["words"]
        assert [x["word"] for x in words] == ["w1", "w2"], words
        client.close()
        closed = json.loads(w.receive_text())
        assert closed["type"] == "closed" and closed["stream"] == snap["stream"], closed
assert sid not in srv.LIVE and sid not in srv.WATCHERS, (srv.LIVE, srv.WATCHERS)
print("OK live fan-out")
