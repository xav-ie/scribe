"""Run the server without a GPU: NeMo, torch and the MCP SDK are stubbed before
stream_server is imported, and StreamState is swapped for a fake that decodes
each step into words a test scripts. Run with `pytest server/tests` (the flake's
`server-tests` check does)."""

import importlib
import sys
import time
import types
from pathlib import Path
from typing import ClassVar
from unittest.mock import MagicMock

import numpy as np
import pytest
import scipy.signal  # noqa: F401  before the torch stub: scipy probes sys.modules["torch"]
from fastapi.testclient import TestClient
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
# scipy's array API shim checks arrays against torch.Tensor when torch is loaded.
sys.modules["torch"].Tensor = type("Tensor", (), {})


class FakeMCP:
    """Records the tools stream_server registers, by name."""

    def __init__(self, *a, **k):
        self.tools = {}

    def tool(self, name=None, **k):
        def register(f):
            self.tools[name or f.__name__] = f
            return f

        return register

    def streamable_http_app(self, *a, **k):
        return Starlette()


class ToolError(Exception):
    pass


sys.modules["mcp.server.mcpserver"].MCPServer = FakeMCP
sys.modules["mcp.server.mcpserver.exceptions"].ToolError = ToolError

sys.path.insert(0, str(Path(__file__).parent.parent))
srv = importlib.import_module("stream_server")

STEP = 1600  # samples per fake step: 0.1 s at 16 kHz


class FakeState:
    """Stands in for StreamState. Each step takes the next entry of `script`
    (the stream's whole word list after that step, as strings) or, when the
    script runs out, appends one word w<n>."""

    script: ClassVar[list[list[str]]] = []
    instances: ClassVar[list["FakeState"]] = []

    def __init__(self):
        self.words = []
        self.pending = np.empty(0, dtype=np.float32)
        self.steps = []
        self.boost = None
        self.closed = False
        self.script = list(type(self).script)
        type(self).instances.append(self)

    def set_boost(self, phrases):
        self.boost = phrases

    def step_size(self):
        return STEP

    def step(self, audio, last=False):
        self.steps.append((audio.shape[0], last))
        if self.script:
            names = self.script.pop(0)
        else:
            names = [w["word"] for w in self.words] + [f"w{len(self.steps)}"]
        self.words = [
            {"word": w, "start": float(i), "end": i + 0.5} for i, w in enumerate(names)
        ]

    def close(self):
        self.closed = True


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "RECORDINGS", tmp_path / "recordings")
    monkeypatch.setattr(srv, "VOCAB", tmp_path / "vocab.json")
    monkeypatch.setattr(srv, "StreamState", FakeState)
    monkeypatch.setattr(FakeState, "script", [])
    monkeypatch.setattr(FakeState, "instances", [])
    srv.LIVE.clear()
    srv.WATCHERS.clear()
    yield srv
    srv.LIVE.clear()
    srv.WATCHERS.clear()


@pytest.fixture
def client(server):
    # One event loop for the whole test: without the context manager each
    # socket gets its own, stopped when it closes, cutting handler cleanup short.
    with TestClient(server.app) as c:
        yield c


@pytest.fixture
def mcp(server):
    return server.mcp.tools


def settle(check, timeout=2.0):
    """Wait for a stream's server side to finish: leaving a TestClient socket
    doesn't wait for the handler's cleanup."""
    deadline = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)


def pcm(samples=STEP):
    return np.zeros(samples, dtype=np.int16).tobytes()


SID = "11111111-2222-3333-4444-555555555555"
