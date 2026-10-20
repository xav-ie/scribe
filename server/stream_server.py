"""Live streaming ASR over WebSocket — NVIDIA parakeet-unified, NeMo buffered RNNT.

A thin, single-purpose service: accept mono int16 PCM frames over a WebSocket
and stream back incrementally-decoded words with timestamps. Each update is
{"type": "words", "from": i, "words": [...]}: replace the client's words from
index i on. Only the last word already sent can still change (a word split
across chunks), so an update never resends the rest of the transcript. NO
diarization — speaker attribution is done client-side in the extension by
joining these word timestamps against the meeting's active-speaker timeline.

The chunk loop follows NeMo's buffered streaming script
(examples/asr/asr_chunked_inference/rnnt/speech_to_text_streaming_infer_rnnt.py,
v3.0.0) at batch size 1: each step re-encodes left context + chunk + right
context and greedily decodes only the chunk, carrying the decoder state over.
Decoded tokens are never revised, so every word sent is final.

Tunables (set by the Nix module via env):
  SCRIBE_DEVICE       cuda, mps (Apple silicon) or cpu; default the first GPU
                      found, CUDA before MPS, and never the CPU by itself
  SCRIBE_MODEL        HF model id (default nvidia/parakeet-unified-en-0.6b)
  SCRIBE_LEFT_S       left context seconds (default 5.6)
  SCRIBE_CHUNK_S      chunk seconds (default 0.56); a step runs every chunk
  SCRIBE_RIGHT_S      right context (lookahead) seconds (default 0.56)
  SCRIBE_TS_OFFSET_S  subtracted from word times (default 0.29): RNNT emits
                      each token a steady ~0.29 s after the word starts
  SCRIBE_RECORDINGS   where streams asking to be saved land (default
                      /cache/recordings): <sessionId>/<channel>.flac holds the
                      16 kHz audio the model heard, <channel>.json its words,
                      and session.json the extension's record posted at stop
  SCRIBE_VOCAB        the global boost list, edited in the UI (default
                      /cache/vocab.json)
  SCRIBE_BOOST_SCORE  per-token boost inside a phrase (default 1.0; 3.0 began
                      forcing names into ordinary words in testing)
  SCRIBE_BOOST_ALPHA  weight of the boost in decoding (default 1.0)
  SCRIBE_TOKEN_FILE   a file holding the access token every client must present
                      (preferred: works with Docker/compose secrets, systemd
                      credentials, agenix/sops). SCRIBE_TOKEN takes the token
                      itself as an escape hatch; setting both is an error.
                      Without either the server is open, and says so.
  SCRIBE_ALLOWED_HOSTS  comma-separated host names the server answers to (e.g.
                      scribe.example.com,localhost); unset answers any Host
  SCRIBE_CLEANUP_URL  an OpenAI-compatible chat server running the scribe
                      cleanup model (e.g. http://127.0.0.1:8080/v1, from
                      mlx_lm.server or llama-server); unset turns cleanup off.
                      Cleanup writes a separate cleaned copy (cleaned.json);
                      the transcript itself never changes
  SCRIBE_CLEANUP_MODEL  the model name sent to that server (default: none,
                      so the server uses the model it loaded)
  SCRIBE_CLEANUP_AUTO  clean each meeting when its recording ends (default
                      1 when SCRIBE_CLEANUP_URL is set; 0 cleans only on
                      request, from the web UI, the API or MCP)
  SCRIBE_WYOMING      host:port for a Wyoming speech-to-text server (Home
                      Assistant's voice pipelines), e.g. 0.0.0.0:10300; unset
                      turns it off. Wyoming has no authentication, so bind it
                      only where nothing untrusted can reach it

A stream's first text message is {"sampleRate", "sessionId", "channel", "save",
"boost", "token"}; "boost" (participant names) is boosted along with the
vocabulary, and "token" is the access token when the server has one.
{"type": "end"} flushes the last partial step and is answered with the final
words and {"type": "done"}; the stream should send no audio after it.

/ws/watch/<sessionId> follows a session's streams while they run: the words so
far, then every update their clients get (see LIVE), or {"type": "idle"} when
none is running.

GET / serves ui.html, a browser for those sessions over the /api routes, and
/mcp is an MCP server (streamable HTTP) for listing, reading and searching
meeting transcripts, keeping cleanups of them (cleanups/<id>.json: notes and a
cleaned transcript an MCP client made; the transcript itself never changes)
and editing the vocabulary.
"""

import asyncio
import contextlib
import ctypes
import functools
import gc
import hashlib
import hmac
import importlib.util
import json
import logging
import math
import os
import re
import sys
import threading
import time
import urllib.request
import uuid
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

import nemo.collections.asr as nemo_asr
import numpy as np
import soundfile as sf
import torch
from fastapi import (
    FastAPI,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from nemo.collections.asr.parts.context_biasing.biasing_multi_model import (
    BiasingRequestItemConfig,
)
from nemo.collections.asr.parts.context_biasing.boosting_graph_batched import (
    BoostingTreeModelConfig,
)
from nemo.collections.asr.parts.submodules.rnnt_decoding import RNNTDecodingConfig
from nemo.collections.asr.parts.utils.streaming_utils import (
    ContextSize,
    StreamingBatchedAudioBuffer,
)
from nemo.utils import logging as nemo_logging
from omegaconf import OmegaConf, open_dict
from scipy.signal import resample_poly
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.requests import HTTPConnection

# NeMo logs the full model config on load — pages of noise. Keep WARNING and up.
nemo_logging.set_verbosity(logging.WARNING)

logger = logging.getLogger(__name__)


def _pick_device(requested, cuda, mps):
    """The torch device to run on: SCRIBE_DEVICE when set, else an NVIDIA GPU,
    else Apple silicon's GPU (Metal). The CPU only when asked for: it would
    rather fail loudly than silently crawl."""
    if requested:
        if requested not in ("cuda", "mps", "cpu"):
            raise RuntimeError(
                f"scribe: SCRIBE_DEVICE {requested!r} is not cuda, mps or cpu"
            )
        if (requested == "cuda" and not cuda) or (requested == "mps" and not mps):
            raise RuntimeError(
                f"scribe: SCRIBE_DEVICE={requested} but it isn't available"
            )
        return requested
    if cuda:
        return "cuda"
    if mps:
        return "mps"
    raise RuntimeError(
        "scribe: no GPU visible (CUDA or Apple MPS); set SCRIBE_DEVICE=cpu to run "
        "on the CPU anyway"
    )


DEVICE = _pick_device(
    os.environ.get("SCRIBE_DEVICE"),
    torch.cuda.is_available(),
    torch.backends.mps.is_available(),
)
print(
    f"[scribe] {DEVICE} ready"
    + (f": {torch.cuda.get_device_name(0)}" if DEVICE == "cuda" else ""),
    flush=True,
)

SAMPLE_RATE = 16000
# Source rates scribe resamples from; anything else is refused. An arbitrary
# rate (a large prime) would build a resampling filter of millions of taps.
RATES = {8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000}
# Audio a stream may queue ahead of transcription (a client sending faster than
# real time), in seconds at its own rate, before it is cut off.
MAX_BACKLOG_S = 600
# Uploads to /v1/audio/transcriptions.
MAX_UPLOAD_BYTES = 100 * 2**20
MAX_CLIP_S = 30 * 60
MODEL_ID = os.environ.get("SCRIBE_MODEL", "nvidia/parakeet-unified-en-0.6b")
LEFT_S = float(os.environ.get("SCRIBE_LEFT_S", "5.6"))
CHUNK_S = float(os.environ.get("SCRIBE_CHUNK_S", "0.56"))
RIGHT_S = float(os.environ.get("SCRIBE_RIGHT_S", "0.56"))
TS_OFFSET_S = float(os.environ.get("SCRIBE_TS_OFFSET_S", "0.29"))
# Phrase boosting (names, jargon): per-token bonus inside a phrase and its weight.
BOOST_SCORE = float(os.environ.get("SCRIBE_BOOST_SCORE", "1.0"))
BOOST_ALPHA = float(os.environ.get("SCRIBE_BOOST_ALPHA", "1.0"))
# The global boost list (product names, jargon, people), edited in the UI.
VOCAB = Path(os.environ.get("SCRIBE_VOCAB", "/cache/vocab.json"))
MAX_PHRASES = 2000
# vocab.json is read, changed and written from worker threads (the UI's PUT,
# the MCP tools); one change at a time.
_vocab_lock = threading.Lock()
MAX_PHRASE_LEN = 100
RECORDINGS = Path(os.environ.get("SCRIBE_RECORDINGS", "/cache/recordings"))
# The session id becomes a directory name, so only accept a UUID.
SESSION_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
# Optional transcript cleanup by a separate model server (see "cleanup" below).
CLEANUP_URL = os.environ.get("SCRIBE_CLEANUP_URL", "").strip().rstrip("/")
CLEANUP_MODEL = os.environ.get("SCRIBE_CLEANUP_MODEL", "").strip()
CLEANUP_AUTO = os.environ.get("SCRIBE_CLEANUP_AUTO", "1").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
)

torch.set_grad_enabled(False)


def _load_model():
    # Cast to bf16 on the CPU before moving to the GPU, so the fp32 weights never
    # land there: loading fp32 on the GPU and casting afterwards leaves ~1.2 GB
    # stranded in PyTorch's cache on a card shared with other services.
    model = nemo_asr.models.ASRModel.from_pretrained(MODEL_ID, map_location="cpu")
    model.freeze()
    model = model.to(torch.bfloat16).to(DEVICE)
    if DEVICE == "cuda":
        torch.cuda.empty_cache()

    cfg = OmegaConf.structured(RNNTDecodingConfig())  # greedy_batch + label looping
    with open_dict(cfg):
        cfg.greedy.preserve_alignments = False
        # Each stream can boost its own phrases (a meeting's participant names).
        cfg.greedy.enable_per_stream_biasing = True
        # Boosting's PyTorch path loops on data, which CUDA-graph capture of the
        # decoder can't record.
        cfg.greedy.use_cuda_graph_decoder = False
        cfg.fused_batch_size = -1
    model.change_decoding_strategy(cfg)
    model.preprocessor.featurizer.dither = 0.0
    model.preprocessor.featurizer.pad_to = 0
    model.eval()
    return model


model = _load_model()
# Loading frees the CPU-side fp32 weights and checkpoint (~4 GB), but glibc keeps
# the freed heap mapped; hand it back to the OS.
gc.collect()
if sys.platform == "linux":
    ctypes.CDLL("libc.so.6").malloc_trim(0)
decoding_computer = model.decoding.decoding.decoding_computer
# Boosting's Triton kernels compile at run time with a C compiler and
# /sbin/ldconfig, which the Nix image doesn't have; use the PyTorch path.
decoding_computer.biasing_multi_model.use_triton = False

_stride = model.cfg.preprocessor["window_stride"]
_sub = model.encoder.subsampling_factor
ENC_SAMPLES = (
    (int(SAMPLE_RATE * _stride) // _sub) * _sub * _sub
)  # samples per encoder frame
FRAME_S = ENC_SAMPLES / SAMPLE_RATE  # 0.08
_ctx_frames = ContextSize(
    left=int(LEFT_S / _stride / _sub),
    chunk=int(CHUNK_S / _stride / _sub),
    right=int(RIGHT_S / _stride / _sub),
)
CTX = ContextSize(
    left=_ctx_frames.left * ENC_SAMPLES,
    chunk=_ctx_frames.chunk * ENC_SAMPLES,
    right=_ctx_frames.right * ENC_SAMPLES,
)
if model.cfg.encoder.att_context_style == "chunked_limited_with_rc":
    model.encoder.set_default_att_context_size(
        att_context_size=[_ctx_frames.left, _ctx_frames.chunk, _ctx_frames.right]
    )


def _load_token(environ):
    """The access token from SCRIBE_TOKEN_FILE (preferred) or SCRIBE_TOKEN, or
    None to leave the server open."""
    path, value = environ.get("SCRIBE_TOKEN_FILE"), environ.get("SCRIBE_TOKEN")
    if path and value:
        raise RuntimeError("scribe: set SCRIBE_TOKEN_FILE or SCRIBE_TOKEN, not both")
    token = Path(path).read_text().strip() if path else (value or "").strip()
    if path and not token:
        raise RuntimeError(f"scribe: SCRIBE_TOKEN_FILE {path} is empty")
    return token or None


TOKEN = _load_token(os.environ)
if TOKEN is None:
    print(
        "[scribe] WARNING: no access token (SCRIBE_TOKEN_FILE); anyone who can "
        "reach this server can stream to it and read every meeting",
        flush=True,
    )
# The web UI's login cookie, sent by the browser to the page and its sockets.
COOKIE = "scribe_token"
# Reachable without a token: the page (it asks for one), the health check, and
# what the page needs to log in.
OPEN_PATHS = {"/", "/health", "/api/info", "/api/login", "/api/logout"}


def _token_ok(candidate):
    return TOKEN is None or (
        isinstance(candidate, str)
        and hmac.compare_digest(candidate.encode(), TOKEN.encode())
    )


def _presented_token(conn):
    """The token a request or socket handshake carries: a bearer header (the
    extension's uploads, MCP and API clients) or the web UI's cookie."""
    auth = conn.headers.get("authorization", "")
    if auth[:7].lower() == "bearer ":
        return auth[7:].strip()
    return conn.cookies.get(COOKIE)


class TokenAuth:
    """Every route but OPEN_PATHS needs the token. /ws checks it itself, since
    the extension can only send it in its first message."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (
            TOKEN is None
            or scope["type"] not in ("http", "websocket")
            or scope["path"] in OPEN_PATHS
            or (scope["type"] == "websocket" and scope["path"] == "/ws")
            or _token_ok(_presented_token(HTTPConnection(scope)))
        ):
            await self.app(scope, receive, send)
        elif scope["type"] == "websocket":
            await receive()  # websocket.connect; closing now refuses it (403)
            await send({"type": "websocket.close", "code": 1008})
        else:
            refused = JSONResponse(
                {"detail": "a token is required"},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
            await refused(scope, receive, send)


app = FastAPI()
app.add_middleware(TokenAuth)
# Listing the names scribe is served under refuses requests for any other Host,
# which stops DNS rebinding: a web page whose own hostname resolves to it.
ALLOWED_HOSTS = [h for h in os.environ.get("SCRIBE_ALLOWED_HOSTS", "").split(",") if h]
if ALLOWED_HOSTS:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)


def _cross_site(websocket):
    """A browser page on another site opening this socket. Browsers don't apply
    CORS to WebSockets; extensions and non-browser clients are fine. Host names
    are compared without ports, and a page on one of SCRIBE_ALLOWED_HOSTS is
    always same-site (a proxy may pass its own Host upstream)."""
    origin = websocket.headers.get("origin")
    if not origin or not origin.startswith(("http://", "https://")):
        return False
    page = urlsplit(origin).hostname
    host = websocket.headers.get("host", "").rsplit(":", 1)[0].strip("[]")
    return page != host and page not in ALLOWED_HOSTS


# Serialize GPU calls — one model, one GPU. Each socket keeps its own state.
_gpu_lock = asyncio.Lock()


class StreamState:
    """All per-connection streaming state — buffers and decoder state must not be shared."""

    def __init__(self):
        self.buffer = StreamingBatchedAudioBuffer(
            batch_size=1, context_samples=CTX, dtype=torch.float32, device=DEVICE
        )
        self.decoder_state = None
        self.pending = np.empty(
            0, dtype=np.float32
        )  # source-rate audio not yet decoded
        self.started = False  # the first step needs chunk + right context
        # Accumulated [{word,start,end}] plus the token ids of each word, so a word
        # split across chunks keeps growing until the next word starts.
        self.words: list[dict] = []
        self.word_ids: list[list[int]] = []
        self.boundary = False  # a bare ▁ token arrived: the next piece starts a word
        # This stream's boosting model in the decoder (-1: none).
        self.boost_id = -1
        self.boost_ids = torch.tensor([-1], device=DEVICE)

    def set_boost(self, phrases):
        """Boost these phrases for the rest of the stream. Blocking — via to_thread."""
        if self.boost_id >= 0 or not phrases:
            return
        request = BiasingRequestItemConfig(
            boosting_model_cfg=BoostingTreeModelConfig(
                key_phrases_list=phrases, context_score=BOOST_SCORE, use_triton=False
            ),
            boosting_model_alpha=BOOST_ALPHA,
        )
        request.add_to_multi_model(
            tokenizer=model.tokenizer,
            biasing_multi_model=decoding_computer.biasing_multi_model,
        )
        self.boost_id = request.multi_model_id
        self.boost_ids = torch.tensor([self.boost_id], device=DEVICE)

    def close(self):
        if self.boost_id >= 0:
            decoding_computer.biasing_multi_model.remove_model(self.boost_id)
            self.boost_id = -1

    def step_size(self):
        return CTX.chunk if self.started else CTX.chunk + CTX.right

    def step(self, audio_16k, last=False):
        """Decode one chunk. Blocking — call via to_thread."""
        n = audio_16k.shape[0]
        audio = torch.from_numpy(audio_16k).unsqueeze(0).to(DEVICE)
        last_b = torch.tensor([last], device=DEVICE)
        with torch.inference_mode():
            self.buffer.add_audio_batch_(
                audio,
                audio_lengths=torch.tensor([n], device=DEVICE),
                is_last_chunk=last,
                is_last_chunk_batch=last_b,
            )
            enc, enc_len = model(
                input_signal=self.buffer.samples,
                input_signal_length=self.buffer.context_size_batch.total(),
            )
            enc = enc.transpose(1, 2)
            ec = self.buffer.context_size.subsample(factor=ENC_SAMPLES)
            ecb = self.buffer.context_size_batch.subsample(factor=ENC_SAMPLES)
            enc = enc[:, ec.left :]
            dec_len = torch.where(last_b, enc_len - ecb.left, ecb.chunk)
            hyps, self.decoder_state = decoding_computer(
                x=enc,
                out_len=dec_len,
                prev_batched_state=self.decoder_state,
                multi_biasing_ids=self.boost_ids,
            )
            k = int(hyps.current_lengths[0])
            ids = hyps.transcript[0, :k].tolist()
            frames = hyps.timestamps[0, :k].tolist()
        self._add_tokens(ids, frames)
        self.started = True

    def _add_tokens(self, ids, frames):
        # Token timestamps are encoder frames from stream start. SentencePiece marks
        # a word's first piece with ▁; a bare ▁ is a lone boundary before the next piece.
        for tid, f in zip(ids, frames, strict=True):
            t = f * FRAME_S
            piece = model.tokenizer.ids_to_tokens([tid])[0]
            if piece == "▁":
                self.boundary = True
                continue
            if piece.startswith("▁") or self.boundary or not self.words:
                self.boundary = False
                self.word_ids.append([tid])
                self.words.append(
                    {
                        "word": "",
                        "start": round(max(0.0, t - TS_OFFSET_S), 2),
                        "end": 0.0,
                    }
                )
            else:
                self.word_ids[-1].append(tid)
            self.words[-1]["word"] = model.tokenizer.ids_to_text(
                self.word_ids[-1]
            ).strip()
            self.words[-1]["end"] = round(max(0.0, t + FRAME_S - TS_OFFSET_S), 2)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": MODEL_ID,
        "left_s": LEFT_S,
        "chunk_s": CHUNK_S,
        "right_s": RIGHT_S,
        "ts_offset_s": TS_OFFSET_S,
    }


async def _on_gpu(fn, *args):
    async with _gpu_lock:
        return await asyncio.to_thread(fn, *args)


async def _transcribe_clip(audio_16k, phrases):
    """A whole clip through the same chunked decoding as /ws, taking the GPU a
    step at a time so live streams keep up meanwhile."""
    state = StreamState()
    try:
        await _on_gpu(state.set_boost, phrases)
        while audio_16k.shape[0] > (size := state.step_size()):
            await _on_gpu(state.step, audio_16k[:size])
            audio_16k = audio_16k[size:]
        await _on_gpu(state.step, audio_16k, True)
    finally:
        await asyncio.shield(_on_gpu(state.close))
    return " ".join(w["word"] for w in state.words)


def _read_clip(f):
    """Mono float32 audio and its rate, or an HTTPException. Blocking."""
    try:
        with sf.SoundFile(f) as clip:
            if clip.samplerate not in RATES:
                raise HTTPException(400, f"unsupported sample rate {clip.samplerate}")
            if clip.frames > MAX_CLIP_S * clip.samplerate:
                raise HTTPException(413, f"clips are limited to {MAX_CLIP_S} s")
            audio = clip.read(dtype="float32")
    except RuntimeError as e:
        raise HTTPException(400, f"unreadable audio: {e}") from None
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return _to_16k(audio, clip.samplerate)


@app.post("/v1/audio/transcriptions")
async def transcriptions(file: UploadFile):
    """OpenAI-style batch transcription (dictation tools), boosted with the
    vocabulary. Only `file` is read; model/prompt/response_format are ignored
    and the reply is always {"text"}."""
    if file.size is not None and file.size > MAX_UPLOAD_BYTES:
        raise HTTPException(413)
    audio = await asyncio.to_thread(_read_clip, file.file)
    if audio.size == 0:
        return {"text": ""}
    return {"text": await _transcribe_clip(audio, _boost_phrases(None))}


# Wyoming (https://github.com/OHF-Voice/wyoming): JSON-line events over TCP, each
# optionally followed by more JSON data and a binary payload.
WYOMING = os.environ.get("SCRIBE_WYOMING", "").strip()
MAX_WYOMING_EVENT = 2**20
_WYOMING_ARTIFACT = {
    "attribution": {"name": "NVIDIA", "url": f"https://huggingface.co/{MODEL_ID}"},
    "installed": True,
    "version": None,
}
WYOMING_INFO = {
    "asr": [
        {
            "name": "scribe",
            "description": "scribe speech-to-text",
            **_WYOMING_ARTIFACT,
            "models": [
                {
                    "name": MODEL_ID,
                    "description": MODEL_ID,
                    "languages": ["en"],
                    **_WYOMING_ARTIFACT,
                }
            ],
        }
    ]
}


async def _read_wyoming(reader):
    """The next (type, data, payload), or None at the end of the stream."""
    line = await reader.readline()
    if not line:
        return None
    header = json.loads(line)
    data = header.get("data") or {}
    lengths = header.get("data_length") or 0, header.get("payload_length") or 0
    if any(n < 0 or n > MAX_WYOMING_EVENT for n in lengths):
        raise ValueError(f"oversized event {header.get('type')}")
    if lengths[0]:
        data |= json.loads(await reader.readexactly(lengths[0]))
    payload = await reader.readexactly(lengths[1]) if lengths[1] else b""
    return header["type"], data, payload


def _write_wyoming(writer, kind, data):
    writer.write(json.dumps({"type": kind, "data": data}).encode() + b"\n")


async def _wyoming_client(reader, writer):
    """One Wyoming connection: answers describe with this server's model, and
    transcribes the audio between audio-start and audio-stop, boosted with the
    vocabulary like /v1/audio/transcriptions."""
    chunks, rate, channels = [], SAMPLE_RATE, 1
    try:
        while event := await _read_wyoming(reader):
            kind, data, payload = event
            if kind == "describe":
                _write_wyoming(writer, "info", WYOMING_INFO)
            elif kind == "audio-start":
                chunks, rate, channels = [], data["rate"], data["channels"]
                if rate not in RATES or data["width"] != 2 or channels < 1:
                    raise ValueError(f"unsupported audio {data}")
            elif kind == "audio-chunk":
                chunks.append(payload)
                if sum(map(len, chunks)) > MAX_CLIP_S * rate * 2 * channels:
                    raise ValueError(f"clips are limited to {MAX_CLIP_S} s")
            elif kind == "audio-stop":
                pcm = b"".join(chunks)
                pcm = pcm[: len(pcm) - len(pcm) % (2 * channels)]
                audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
                audio = _to_16k(audio.reshape(-1, channels).mean(axis=1), rate)
                text = ""
                if audio.size:
                    text = await _transcribe_clip(audio, _boost_phrases(None))
                _write_wyoming(writer, "transcript", {"text": text})
                chunks = []
            await writer.drain()
    except (ValueError, KeyError, TypeError, asyncio.IncompleteReadError) as e:
        print(f"[scribe] wyoming client dropped: {e!r}", flush=True)
    except ConnectionError:
        pass
    finally:
        writer.close()


class Recording:
    """One saved stream: the 16 kHz audio fed to the model plus, on close, its words.

    A channel reopened within a session (the mic toggled off and on) gets a
    numbered stem, so earlier streams are kept.
    """

    def __init__(self, session_id, channel, src_rate):
        folder = RECORDINGS / session_id
        folder.mkdir(parents=True, exist_ok=True)
        stem, n = channel, 1
        while (folder / f"{stem}.json").exists() or (folder / f"{stem}.flac").exists():
            n += 1
            stem = f"{channel}-{n}"
        self.audio_path = folder / f"{stem}.flac"
        self.meta_path = folder / f"{stem}.json"
        self.meta = {
            "sessionId": session_id,
            "channel": channel,
            "sourceSampleRate": src_rate,
            "startedAt": datetime.now(UTC).isoformat(),
            "model": MODEL_ID,
        }
        self.audio = sf.SoundFile(
            self.audio_path,
            "w",
            samplerate=SAMPLE_RATE,
            channels=1,
            format="FLAC",
            subtype="PCM_16",
        )

    def close(self, words, tail):
        # Each step runs even if an earlier one fails, so a write error (disk
        # full) still closes the file and keeps the words.
        try:
            self.audio.write(tail)
        finally:
            try:
                self.audio.close()
            finally:
                # A stream that closed before any audio leaves an unreadable
                # zero-frame FLAC; keep only the metadata.
                if self.audio.frames == 0:
                    self.audio_path.unlink(missing_ok=True)
                _write_json(self.meta_path, {**self.meta, "words": words})


def _write_json(path, data):
    # Readers (the session browser) never see a half-written file.
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(path)


def _read_json(path):
    """None when missing or unreadable, so one bad file can't break a listing."""
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return None


def _to_16k(audio, src_rate):
    if src_rate == SAMPLE_RATE:
        return audio
    g = math.gcd(src_rate, SAMPLE_RATE)
    return resample_poly(audio, SAMPLE_RATE // g, src_rate // g).astype(np.float32)


def _parse_config(text):
    try:
        config = json.loads(text)
    except ValueError:
        return None
    return config if isinstance(config, dict) else None


def _sample_rate(value):
    """A client's declared rate, or None when it isn't one we can resample from."""
    try:
        rate = int(value)
    except (TypeError, ValueError):
        return None
    return rate if rate in RATES else None


def _open_recording(config, src_rate):
    session_id, channel = config.get("sessionId"), config.get("channel")
    if (
        not config.get("save")
        or not SESSION_ID_RE.fullmatch(str(session_id))
        or channel not in ("tab", "mic")
    ):
        return None
    return Recording(session_id, channel, src_rate)


# --- live streams ------------------------------------------------------------

# Streams in progress, by session: {sessionId: {stream id: (channel, StreamState)}}.
# Watchers of a session (/ws/watch, the web UI) get each stream's word updates,
# the same {"type": "words", "from", "words"} its own client gets, tagged with
# "stream" and "channel"; {"type": "closed", "stream"} ends one.
LIVE = {}
WATCHERS = {}


def _publish(session_id, msg):
    # ponytail: unbounded queues; a stalled watcher grows until it disconnects.
    text = json.dumps(msg)
    for queue in WATCHERS.get(session_id, ()):
        queue.put_nowait(text)


# --- session browser ---------------------------------------------------------

UI_HTML = (Path(__file__).parent / "ui.html").read_text()
STEM_RE = re.compile(r"^(tab|mic)(-[0-9]+)?$")
MAX_SESSION_BYTES = 50 * 2**20
MAX_VOCAB_BYTES = 2 * 2**20


def _clean_phrases(items):
    """Strings only, trimmed, bounded, deduplicated in order."""
    out = {}
    for item in items if isinstance(items, list) else []:
        if (
            isinstance(item, str)
            and (p := " ".join(item.split()))
            and len(p) <= MAX_PHRASE_LEN
        ):
            out.setdefault(p, None)
    return list(out)[:MAX_PHRASES]


def _boost_phrases(names):
    """The vocabulary plus a meeting's participant names, and their first names,
    which is how people are usually addressed."""
    names = _clean_phrases(names)
    firsts = [n.split()[0] for n in names if len(n.split()) > 1]
    return _clean_phrases((_read_json(VOCAB) or []) + names + firsts)


def _session_dir(session_id):
    if not SESSION_ID_RE.fullmatch(session_id):
        raise HTTPException(404)
    return RECORDINGS / session_id


def _channels(folder, with_words):
    """Saved streams in a session. A stream still being recorded has audio but no
    metadata yet, and its FLAC header isn't final."""
    stems = {p.stem for p in folder.glob("*.flac")} | {
        p.stem for p in folder.glob("*.json") if STEM_RE.fullmatch(p.stem)
    }
    out = []
    for stem in sorted(stems):
        meta_path, audio_path = folder / f"{stem}.json", folder / f"{stem}.flac"
        meta = _read_json(meta_path) or {}
        if not with_words:
            meta.pop("words", None)
        try:
            duration = sf.info(audio_path).duration if audio_path.exists() else 0.0
        except RuntimeError:
            duration = None
        out.append(
            {**meta, "stem": stem, "audio": audio_path.exists(), "duration": duration}
        )
    return out


def _read_session(folder):
    """The extension's record, with the fields scribe reads coerced to their
    expected shapes: anyone on the network can post one, and a malformed record
    must not break the listing or the MCP tools."""
    session = _read_json(folder / "session.json")
    if not isinstance(session, dict):
        return None

    def number(value):
        ok = isinstance(value, int | float) and not isinstance(value, bool)
        return value if ok and math.isfinite(value) else None

    for key in ("startedAt", "stoppedAt"):
        session[key] = number(session.get(key))
    if not isinstance(session.get("platform"), str):
        session["platform"] = None
    session["segments"] = [
        seg
        for seg in session.get("segments") or []
        if isinstance(seg, dict)
        and isinstance(seg.get("speaker"), str)
        and isinstance(seg.get("text"), str)
        and number(seg.get("start")) is not None
    ]
    return session


# The browser routes are plain `def`, so FastAPI runs their file work in its
# threadpool instead of on the event loop serving live /ws streams.
@app.get("/", response_class=HTMLResponse)
def ui():
    return UI_HTML


@app.get("/api/info")
def info():
    """Whether this server needs a token (clients warn when it doesn't), and
    whether transcript cleanup is configured."""
    return {"auth": TOKEN is not None, "cleanup": bool(CLEANUP_URL)}


def _secure(request):
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    return proto.split(",")[0].strip() in ("https", "wss")


@app.post("/api/login")
async def login(request: Request):
    """The web UI trades the token for a cookie, which its audio players and
    live view (which can't send headers) then carry."""
    body = await _json_body(request, 4096)
    token = body.get("token") if isinstance(body, dict) else None
    if TOKEN is None or not _token_ok(token):
        raise HTTPException(401)
    response = JSONResponse({"ok": True})
    response.set_cookie(
        COOKIE,
        TOKEN,
        max_age=365 * 24 * 3600,
        httponly=True,
        samesite="strict",
        secure=_secure(request),
    )
    return response


@app.post("/api/logout")
def logout():
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE)
    return response


@app.get("/api/pairing")
def pairing(request: Request):
    """The URL to paste into the extension's settings, token included. Only
    reachable with the token, so it reveals nothing new."""
    scheme = "wss" if _secure(request) else "ws"
    host = request.headers.get("x-forwarded-host", request.url.netloc)
    url = f"{scheme}://{host}/ws"
    return {"url": f"{url}#token={TOKEN}" if TOKEN else url}


@app.get("/api/sessions")
def list_sessions():
    out = []
    for folder in RECORDINGS.iterdir() if RECORDINGS.exists() else ():
        if not folder.is_dir() or not SESSION_ID_RE.fullmatch(folder.name):
            continue
        session = _read_session(folder) or {}
        segments = session.get("segments") or []
        out.append(
            {
                "sessionId": folder.name,
                "startedAt": session.get("startedAt"),
                "stoppedAt": session.get("stoppedAt"),
                "platform": session.get("platform"),
                "speakers": sorted({s["speaker"] for s in segments}),
                "words": sum(len(s["text"].split()) for s in segments),
                "channels": _channels(folder, with_words=False),
                "hasRecord": bool(session),
                "modified": folder.stat().st_mtime,
                "live": folder.name in LIVE,
            }
        )
    # Live sessions not saving audio have no folder yet.
    listed = {s["sessionId"] for s in out}
    for session_id in LIVE.keys() - listed:
        out.append(
            {
                "sessionId": session_id,
                "startedAt": None,
                "stoppedAt": None,
                "platform": None,
                "speakers": [],
                "words": 0,
                "channels": [],
                "hasRecord": False,
                "modified": datetime.now(UTC).timestamp(),
                "live": True,
            }
        )
    return sorted(
        out, key=lambda s: s["startedAt"] or s["modified"] * 1000, reverse=True
    )


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str, cleaned: bool = False):
    """A session: the extension's record (its segments are the raw
    transcript), the saved streams, and the cleaned copy's status; with
    ?cleaned=true, also the cleaned copy's lines."""
    folder = _session_dir(session_id)
    live = session_id in LIVE
    if not folder.is_dir() and not live:
        raise HTTPException(404)
    session = _read_session(folder)
    return {
        "sessionId": session_id,
        "session": session,
        "channels": _channels(folder, with_words=True),
        "live": live,
        "cleaned": _cleaned_view(session_id, session, with_lines=cleaned),
    }


async def _json_body(request, limit):
    """The request's JSON, refused (413) as soon as it passes `limit` bytes
    rather than after buffering all of it."""
    if int(request.headers.get("content-length") or 0) > limit:
        raise HTTPException(413)
    body = bytearray()
    async for part in request.stream():
        body += part
        if len(body) > limit:
            raise HTTPException(413)
    try:
        return json.loads(body)
    except ValueError:
        raise HTTPException(400) from None


@app.post("/api/sessions/{session_id}")
async def put_session(session_id: str, request: Request):
    """The extension's record of a finished recording: transcript, speaker
    timeline, per-stream words and clocks, adapter snapshots."""
    folder = _session_dir(session_id)
    # A JSON content type can't be sent cross-site without a CORS preflight,
    # which scribe never grants, so other sites can't plant records.
    if request.headers.get("content-type", "").split(";")[0] != "application/json":
        raise HTTPException(415)
    record = await _json_body(request, MAX_SESSION_BYTES)
    if not isinstance(record, dict):
        raise HTTPException(400)

    def save():
        folder.mkdir(parents=True, exist_ok=True)
        _write_json(folder / "session.json", record)

    await asyncio.to_thread(save)
    # The extension posts its record when the recording ends.
    if CLEANUP_URL and CLEANUP_AUTO and (_read_session(folder) or {}).get("segments"):
        _start_cleanup(session_id)
    return {"ok": True}


@app.get("/api/vocab")
def read_vocab():
    return {"phrases": _read_json(VOCAB) or []}


@app.put("/api/vocab")
async def put_vocab(request: Request):
    body = await _json_body(request, MAX_VOCAB_BYTES)
    phrases = _clean_phrases(body.get("phrases") if isinstance(body, dict) else None)

    def save():
        with _vocab_lock:
            _write_json(VOCAB, phrases)

    await asyncio.to_thread(save)
    return {"phrases": phrases}


@app.get("/api/sessions/{session_id}/audio/{stem}")
def get_audio(session_id: str, stem: str):
    path = _session_dir(session_id) / f"{stem}.flac"
    if not STEM_RE.fullmatch(stem) or not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="audio/flac")


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    if _cross_site(websocket):
        await websocket.close(1008)
        return
    await websocket.accept()
    # A token in the handshake (bearer header, or the web UI's cookie) or in
    # the first message, which is all the extension can send.
    authed = _token_ok(_presented_token(websocket))
    state = StreamState()
    recording = None

    # The extension's AudioContext is usually 48 kHz; a text message
    # {"sampleRate": N, "sessionId", "channel", "save"} (sent first) sets the
    # source rate, resampled to 16 kHz here, and whether to keep the audio.
    # Binary messages are raw int16-LE mono PCM.
    src_rate = SAMPLE_RATE
    configured = False

    sent = 0  # words the client has; the last of them may still grow
    connected = True
    stream_id = uuid.uuid4().hex
    live = None  # (sessionId, channel) once the stream says which meeting it is

    async def send():
        nonlocal sent, connected
        start = max(0, sent - 1)
        sent = len(state.words)
        update = {"type": "words", "from": start, "words": state.words[start:]}
        if live is not None:
            _publish(live[0], {**update, "stream": stream_id, "channel": live[1]})
        if not connected:
            return
        try:
            await websocket.send_text(json.dumps(update))
        except Exception:  # client gone: keep transcribing what it already sent
            logger.debug("word push failed; client disconnected", exc_info=True)
            connected = False

    # A client may send audio faster than real time (a recorded file). Take every
    # message off the socket as soon as it arrives, so the connection's own
    # traffic (keepalive pongs) is never stuck behind audio still waiting to be
    # transcribed, and work through the backlog from this queue. Audio received
    # before a disconnect is still transcribed (and saved).
    # The backlog is bounded, though: a stream that gets MAX_BACKLOG_S of audio
    # ahead of transcription is cut off rather than allowed to fill memory.
    inbox = asyncio.Queue()
    backlog = 0  # bytes of audio queued in the inbox
    overflow = False
    ended = False  # {"type": "end"} came: nothing after it is decoded

    async def read():
        nonlocal backlog, overflow
        try:
            while True:
                msg = await websocket.receive()
                backlog += len(msg.get("bytes") or b"")
                if backlog > MAX_BACKLOG_S * src_rate * 2:
                    overflow = True
                    return
                await inbox.put(msg)
                if msg.get("type") == "websocket.disconnect":
                    return
        finally:
            # However the reader ends, the worker sees the end of the stream and
            # finishes up (saves the recording) instead of waiting forever.
            inbox.put_nowait({"type": "websocket.disconnect"})

    reader = asyncio.create_task(read())
    try:
        while True:
            msg = await inbox.get()
            backlog -= len(msg.get("bytes") or b"")
            if overflow:
                await websocket.close(
                    1008, "audio arriving faster than it can be transcribed"
                )
                break
            if msg.get("type") == "websocket.disconnect":
                break
            if ended:
                continue
            if msg.get("text"):
                config = _parse_config(msg["text"])
                if config is None:
                    await websocket.close(1003, "expected a JSON object")
                    break
                authed = authed or _token_ok(config.get("token"))
                if not authed:
                    await websocket.close(1008, "a token is required")
                    break
                # The client is done talking: decode the audio still short of a
                # step (and the right context held back), then say so.
                if config.get("type") == "end":
                    ended = True
                    tail = _to_16k(state.pending, src_rate)
                    state.pending = np.empty(0, dtype=np.float32)
                    if recording is not None:
                        recording.audio.write(tail)
                    if tail.size == 0:
                        tail = np.zeros(1, dtype=np.float32)
                    async with _gpu_lock:
                        await asyncio.to_thread(state.step, tail, True)
                    await send()
                    await websocket.send_text(json.dumps({"type": "done"}))
                    continue
                # The first rate holds for the whole stream: audio already
                # buffered (and saved) is at that rate.
                if "sampleRate" in config and not configured:
                    configured = True
                    src_rate = _sample_rate(config["sampleRate"])
                    if src_rate is None:
                        await websocket.close(1003, "unsupported sampleRate")
                        break
                    if recording is None:
                        recording = _open_recording(config, src_rate)
                    session_id = str(config.get("sessionId"))
                    if live is None and SESSION_ID_RE.fullmatch(session_id):
                        live = (session_id, str(config.get("channel") or "audio"))
                        LIVE.setdefault(session_id, {})[stream_id] = (live[1], state)
                    phrases = _boost_phrases(config.get("boost"))
                    if phrases:
                        async with _gpu_lock:
                            await asyncio.to_thread(state.set_boost, phrases)
                    if recording is not None:
                        recording.meta["boost"] = phrases
                # Wall-clock ms of the stream's first sample, sent once audio starts.
                if recording is not None and "epoch" in config:
                    recording.meta["epoch"] = config["epoch"]
                continue
            raw = msg.get("bytes")
            if not raw:
                continue
            if not authed:
                await websocket.close(1008, "a token is required")
                break
            if len(raw) % 2:
                await websocket.close(1003, "PCM frames must be whole int16 samples")
                break
            chunk = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            state.pending = np.concatenate([state.pending, chunk])
            # Resample one whole step at a time (not each small message), so
            # filter edge effects land only on step boundaries.
            while state.pending.shape[0] >= (
                size := round(state.step_size() * src_rate / SAMPLE_RATE)
            ):
                seg, state.pending = state.pending[:size], state.pending[size:]
                seg = _to_16k(seg, src_rate)
                if recording is not None:
                    recording.audio.write(seg)
                async with _gpu_lock:
                    await asyncio.to_thread(state.step, seg)
                await send()
    except WebSocketDisconnect:
        pass
    finally:
        reader.cancel()
        if live is not None:
            streams = LIVE.get(live[0], {})
            streams.pop(stream_id, None)
            if not streams:
                LIVE.pop(live[0], None)

        async def cleanup():
            try:
                if recording is not None:
                    # Keep the tail shorter than one step too, so the file is complete.
                    tail = _to_16k(state.pending, src_rate)
                    await asyncio.to_thread(recording.close, state.words, tail)
            finally:
                # After the recording is complete, so a watcher reloading the
                # session on "closed" finds its words and a final FLAC; and
                # even when saving failed (a full disk).
                if live is not None:
                    _publish(live[0], {"type": "closed", "stream": stream_id})
                async with _gpu_lock:
                    await asyncio.to_thread(state.close)

        # Shielded: a cancelled handler (server shutdown) must still free the
        # stream's boost model and save its words.
        await asyncio.shield(cleanup())


@app.websocket("/ws/watch/{session_id}")
async def watch(websocket: WebSocket, session_id: str):
    """Follow a session's live streams: each one's words so far as a "words"
    update from 0, then the updates its client gets, as they happen. A session
    with no stream running when the watcher joins gets {"type": "idle"}."""
    if _cross_site(websocket):
        await websocket.close(1008)
        return
    await websocket.accept()
    # Snapshot and subscribe with no await in between, so every update queued
    # for this watcher is newer than the snapshot it follows.
    snapshot = [
        json.dumps(
            {"type": "words", "from": 0, "words": state.words}
            | {"stream": stream_id, "channel": channel}
        )
        for stream_id, (channel, state) in LIVE.get(session_id, {}).items()
    ]
    # None running: it ended between the page's last look and this socket.
    queue = asyncio.Queue()
    for text in snapshot or [json.dumps({"type": "idle"})]:
        queue.put_nowait(text)
    WATCHERS.setdefault(session_id, set()).add(queue)

    async def forward():
        while True:
            await websocket.send_text(await queue.get())

    # Reading the socket notices a closed tab even when no updates are coming.
    sender = asyncio.create_task(forward())
    try:
        while (await websocket.receive())["type"] != "websocket.disconnect":
            pass
    finally:
        sender.cancel()
        watchers = WATCHERS.get(session_id, set())
        watchers.discard(queue)
        if not watchers:
            WATCHERS.pop(session_id, None)


# --- cleanup -----------------------------------------------------------------

# Optional: the scribe cleanup model (models/cleanup/MODEL_CARD.md) tidies a
# finished transcript. It runs behind any OpenAI-compatible chat server at
# SCRIBE_CLEANUP_URL; scribe only sends it chunks of the transcript and passes
# every answer through the model's own safety check (models/cleanup/guard.py),
# which keeps the raw line wherever a timestamp, speaker, number or "not"
# changed. The result is a separate copy, <session>/cleaned.json; session.json
# is never written. cleaning.json holds the latest run's progress and status.
CHUNK_WORDS = 250  # whole lines up to about this many words per request
PREVIOUS_WORDS = 80  # earlier context sent with each chunk, as in training
PREVIOUS_LINES = 5
CLEANUP_TIMEOUT_S = 600  # one chunk; a CPU-only llama-server is slow


@functools.cache
def _cleanup_kit():
    """(guard module, system prompt, prompt version) from models/cleanup: next
    to this file in the image and the Nix build, or in the checkout."""
    here = Path(__file__).parent
    for folder in (here / "cleanup", here.parent / "models" / "cleanup"):
        if (folder / "guard.py").is_file() and (folder / "prompt.txt").is_file():
            break
    else:
        raise RuntimeError("scribe: models/cleanup (guard.py, prompt.txt) not found")
    spec = importlib.util.spec_from_file_location(
        "scribe_cleanup_guard", folder / "guard.py"
    )
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    prompt = (folder / "prompt.txt").read_text().strip()
    return guard, prompt, hashlib.sha256(prompt.encode()).hexdigest()[:12]


if CLEANUP_URL:
    _cleanup_kit()  # fail at start, not after the first meeting
    print(
        f"[scribe] cleanup by {CLEANUP_URL}"
        + (" after every recording" if CLEANUP_AUTO else " on request"),
        flush=True,
    )


def _raw_lines(session):
    """The transcript as (m:ss, speaker, text), one per segment, in the form the
    cleanup model was trained on. A speaker can't hold a colon there."""
    return [
        (
            _clock(max(0, s["start"])),
            " ".join(s["speaker"].replace(":", " ").split()) or "Unknown",
            " ".join(s["text"].split()),
        )
        for s in (session or {}).get("segments") or []
    ]


def _fmt(lines):
    return "\n".join(f"[{t}] {s}: {x}".rstrip() for t, s, x in lines)


def _source_hash(lines):
    """Identifies the transcript a cleaned copy was made from."""
    return hashlib.sha256(_fmt(lines).encode()).hexdigest()[:16]


def _chunks(lines):
    """Index ranges of whole lines, about CHUNK_WORDS words each. A line longer
    than that is a chunk of its own."""
    out, start, words = [], 0, 0
    for i, (_, _, text) in enumerate(lines):
        n = len(text.split())
        if i > start and words + n > CHUNK_WORDS:
            out.append(range(start, i))
            start, words = i, 0
        words += n
    if start < len(lines):
        out.append(range(start, len(lines)))
    return out


def _previous(lines, start):
    """Up to PREVIOUS_WORDS words of the lines before `start`, the earliest one
    cut from its beginning when it doesn't fit."""
    out, budget = [], PREVIOUS_WORDS
    for t, s, text in reversed(lines[max(0, start - PREVIOUS_LINES) : start]):
        if budget <= 0:
            break
        words = text.split()
        out.insert(0, (t, s, " ".join(words[-budget:])))
        budget -= len(words)
    return out


def _cleanup_request(lines, chunk, participants):
    """The user message for one chunk, as MODEL_CARD.md describes."""
    context = (
        f"<context>\nparticipants: {', '.join(participants)}\n</context>\n"
        if participants
        else ""
    )
    previous = _previous(lines, chunk.start)
    previous = f"<previous>\n{_fmt(previous)}\n</previous>\n" if previous else ""
    return f"{context}{previous}<transcript>\n{_fmt(lines[chunk.start : chunk.stop])}\n</transcript>"


def _chat(system, user, max_tokens):
    """One completion from SCRIBE_CLEANUP_URL: (text, model name)."""
    body = {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    if CLEANUP_MODEL:
        body["model"] = CLEANUP_MODEL
    request = urllib.request.Request(
        f"{CLEANUP_URL}/chat/completions",
        json.dumps(body).encode(),
        {"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=CLEANUP_TIMEOUT_S) as response:
        reply = json.load(response)
    return reply["choices"][0]["message"]["content"] or "", reply.get("model")


# A word or a phrase of up to 3 words said 5 or more times in a row: a speech
# recognition loop ("two two two two two ..."). The cleanup model learned to cut
# one to a single copy, but a long one can tip it into repeating it instead, so
# it is cut before the model sees it.
_LOOP = re.compile(
    r"\b(\w+(?:'\w+)?(?: \w+(?:'\w+)?){0,2}?)(?:[ ,.!?]+\1\b){4,}", re.IGNORECASE
)


def _cut_loops(text):
    return _LOOP.sub(r"\1", text)


def _clean_chunk(lines, chunk, participants):
    """Cleaned texts for the chunk's lines, whether each was kept raw, and the
    model's name. Every answer goes through guard.guard_lines, against the lines
    as sent: with recognition loops cut, otherwise as spoken."""
    guard, prompt, _ = _cleanup_kit()
    spoken = [x for _, _, x in lines[chunk.start : chunk.stop]]
    lines = [(t, s, _cut_loops(x)) for t, s, x in lines]
    raw = [f"[{t}] {s}: {x}".rstrip() for t, s, x in lines[chunk.start : chunk.stop]]
    # Tokens of the chunk, roughly (meeting English runs about 3.5 to 4
    # characters a token); the answer is about as long as the question.
    tokens = len("\n".join(raw)) // 3
    answer, model = _chat(
        prompt, _cleanup_request(lines, chunk, participants), int(1.3 * tokens) + 64
    )
    cleaned = [line.strip() for line in answer.splitlines() if line.strip()]
    shown, reverted = guard.guard_lines(raw, cleaned)
    matches = [guard.LINE.match(line) for line in shown]
    if len(matches) != len(raw) or not all(matches):
        # Can't happen with lines from _raw_lines; keep the chunk raw if it does.
        return spoken, [True] * len(raw), model
    # Kept raw: the guard showed the raw line where the model had changed it
    # (or broke the chunk's line format, which keeps the whole chunk raw).
    whole = len(cleaned) != len(raw)
    kept = [
        reverted > 0 and shown[i] == raw[i] and (whole or cleaned[i] != raw[i])
        for i in range(len(raw))
    ]
    # A line kept raw shows what was said, loop and all.
    texts = [
        spoken[i] if kept[i] else m.group(3).strip() for i, m in enumerate(matches)
    ]
    return texts, kept, model


# Runs in progress or waiting, by session id: {"status", "chunksDone", ...}.
# One run at a time (one model server); each in its own thread, so neither
# the event loop nor live transcription ever waits on it.
_JOBS = {}
_jobs_lock = threading.Lock()
_model_lock = threading.Lock()


def _set_job(session_id, **fields):
    with _jobs_lock:
        job = _JOBS.setdefault(session_id, {})
        job.update(fields)
        snapshot = dict(job)
    snapshot.pop("again", None)
    _write_json(RECORDINGS / session_id / "cleaning.json", snapshot)
    return snapshot


def _start_cleanup(session_id):
    """Clean a session's transcript in the background, unless it's already
    queued or running (then it runs once more after, for a newer record).
    Returns the run's status."""
    with _jobs_lock:
        job = _JOBS.get(session_id)
        if job and job["status"] in ("queued", "running"):
            job["again"] = True
            return {k: v for k, v in job.items() if k != "again"}
        _JOBS[session_id] = {}
    status = _set_job(
        session_id,
        status="queued",
        chunksDone=0,
        chunks=None,
        error=None,
        queuedAt=_now(),
        startedAt=None,
        finishedAt=None,
    )
    threading.Thread(target=_cleanup_worker, args=(session_id,), daemon=True).start()
    return status


def _cleanup_worker(session_id):
    while True:
        with _model_lock:
            try:
                _clean_session(session_id)
            except (
                Exception
            ) as e:  # reported in the status; the transcript is untouched
                logger.warning("cleanup of %s failed", session_id, exc_info=True)
                _set_job(
                    session_id,
                    status="failed",
                    error=str(e) or type(e).__name__,
                    finishedAt=_now(),
                )
        with _jobs_lock:
            again = _JOBS[session_id].pop("again", False)
        if not again:
            return
        _set_job(session_id, status="queued", chunksDone=0, chunks=None, error=None)


def _model_name(reported):
    """The model the server says answered. mlx_lm.server says default_model
    when none was asked for, which names nothing; llama-server gives its file."""
    return reported if reported and reported != "default_model" else None


def _clean_session(session_id):
    folder = RECORDINGS / session_id
    session = _read_session(folder)
    lines = _raw_lines(session)
    if not lines:
        raise RuntimeError("no transcript to clean")
    _, _, prompt_version = _cleanup_kit()
    chunks = _chunks(lines)
    started, t0 = _now(), time.monotonic()
    _set_job(session_id, status="running", chunks=len(chunks), startedAt=started)
    participants = _participants(session)
    texts, kept, model = [], [], None
    for done, chunk in enumerate(chunks, 1):
        t, k, model = _clean_chunk(lines, chunk, participants)
        texts += t
        kept += k
        _set_job(session_id, chunksDone=done)
    segments = session["segments"]
    _write_json(
        folder / "cleaned.json",
        {
            "model": CLEANUP_MODEL or _model_name(model),
            "promptVersion": prompt_version,
            "source": _source_hash(lines),
            "startedAt": started,
            "finishedAt": _now(),
            "seconds": round(time.monotonic() - t0, 1),
            "chunks": len(chunks),
            "keptRaw": sum(kept),
            "lines": [
                {"start": seg["start"], "speaker": seg["speaker"], "text": text}
                | ({"keptRaw": True} if raw else {})
                for seg, text, raw in zip(segments, texts, kept, strict=True)
            ],
        },
    )
    _set_job(session_id, status="done", finishedAt=_now())


def _cleaning(session_id):
    """The latest run's status, or None. One a restart cut short says so."""
    with _jobs_lock:
        job = _JOBS.get(session_id)
        if job is not None:
            return {k: v for k, v in job.items() if k != "again"}
    job = _read_json(RECORDINGS / session_id / "cleaning.json")
    if isinstance(job, dict) and job.get("status") in ("queued", "running"):
        job |= {"status": "failed", "error": "the server stopped before it finished"}
    return job if isinstance(job, dict) else None


def _cleaned_copy(session_id, session):
    """The cleaned copy, marked stale when the transcript changed since."""
    copy = _read_json(RECORDINGS / session_id / "cleaned.json")
    if not isinstance(copy, dict) or not isinstance(copy.get("lines"), list):
        return None
    return copy | {"stale": copy.get("source") != _source_hash(_raw_lines(session))}


def _cleaned_view(session_id, session, with_lines):
    """What the API reports about cleanup for a session: whether it's
    configured, the latest run, and the cleaned copy (lines on request)."""
    copy = _cleaned_copy(session_id, session)
    if copy is not None:
        copy["lineCount"] = len(copy["lines"])
        if not with_lines:
            del copy["lines"]
    return {
        "configured": bool(CLEANUP_URL),
        "available": copy is not None,
        "copy": copy,
        "run": _cleaning(session_id),
    }


@app.post("/api/sessions/{session_id}/clean", status_code=202)
def clean_session(session_id: str, request: Request):
    """Clean (or clean again) a session's transcript in the background; the
    session's "cleaned.run" reports progress."""
    folder = _session_dir(session_id)
    # A JSON content type can't be sent cross-site without a CORS preflight.
    if request.headers.get("content-type", "").split(";")[0] != "application/json":
        raise HTTPException(415)
    if not CLEANUP_URL:
        raise HTTPException(409, "cleanup is off: set SCRIBE_CLEANUP_URL")
    if not (_read_session(folder) or {}).get("segments"):
        raise HTTPException(404, "no transcript for this session")
    return _start_cleanup(session_id)


# --- MCP ---------------------------------------------------------------------

mcp = MCPServer(
    "scribe",
    instructions=(
        "Transcripts of meetings recorded by the meeting capture extension. "
        "Times are UTC. Speakers come from the meeting's active-speaker "
        "indicator; 'Unknown' is speech it couldn't attribute. When the server "
        "runs the cleanup model, a meeting may also have a cleaned copy "
        "(get_transcript with cleaned=true); the original stays the record. "
        "That copy is separate from cleanups, which are notes an agent saved."
    ),
)


def _meeting_dir(session_id):
    if not SESSION_ID_RE.fullmatch(session_id):
        raise ToolError(f"no session {session_id}")
    return RECORDINGS / session_id


def _iso(ms):
    return datetime.fromtimestamp(ms / 1000, UTC).isoformat() if ms else None


def _epoch_ms(iso):
    t = datetime.fromisoformat(iso)
    return (t if t.tzinfo else t.replace(tzinfo=UTC)).timestamp() * 1000


def _sessions_between(since, until):
    lo = _epoch_ms(since) if since else -math.inf
    hi = _epoch_ms(until) if until else math.inf
    return [s for s in list_sessions() if s["startedAt"] and lo <= s["startedAt"] <= hi]


# Tile names that aren't people: unnamed tiles and recording bots.
NOT_A_PERSON_RE = re.compile(
    r"^\?$|notetaker|fireflies|otter\.ai|read\.ai|fathom", re.IGNORECASE
)


def _participants(session):
    """Everyone the meeting UI showed (its participant tiles, from the
    extension's snapshots) plus everyone who spoke, sorted. A tile's
    "(Presentation)" style suffix is dropped."""
    names = {s["speaker"] for s in session.get("segments") or []}
    snapshots = session.get("diagnostics")
    for snapshot in snapshots if isinstance(snapshots, list) else []:
        tiles = snapshot.get("names") if isinstance(snapshot, dict) else None
        for name in tiles if isinstance(tiles, list) else []:
            if isinstance(name, str):
                names.add(re.sub(r"\s*\([^)]*\)$", "", name).strip())
    return sorted(
        n for n in names if n and n != "Unknown" and not NOT_A_PERSON_RE.search(n)
    )


def _cleaned_brief(session_id):
    """list_meetings' summary of the cleanup model's copy and latest run."""
    copy = _read_json(RECORDINGS / session_id / "cleaned.json")
    run = _cleaning(session_id)
    return {
        "available": isinstance(copy, dict),
        "keptRaw": copy.get("keptRaw") if isinstance(copy, dict) else None,
        "run": {k: run.get(k) for k in ("status", "chunksDone", "chunks", "error")}
        if run
        else None,
    }


def _clock(sec):
    return f"{int(sec // 60)}:{int(sec % 60):02d}"


@mcp.tool()
def list_meetings(
    since: str | None = None, until: str | None = None, limit: int = 20
) -> list[dict]:
    """Recorded meetings, newest first. since/until are ISO 8601 times bounding
    when a meeting started (UTC when no offset is given). title is from the
    newest finished cleanup, and cleanup is the newest cleanup's status.
    participants is everyone shown in the meeting, speaking or not. cleaned
    says whether the cleanup model made a cleaned copy (get_transcript with
    cleaned=true reads it) and how its latest run went."""
    out = []
    for s in _sessions_between(since, until)[:limit]:
        cleanups = _cleanups(s["sessionId"])
        done = [c for c in cleanups if c["status"] == "done"]
        out.append(
            {
                "sessionId": s["sessionId"],
                "title": done[-1]["notes"].get("title") if done else None,
                "startedAt": _iso(s["startedAt"]),
                "stoppedAt": _iso(s["stoppedAt"]),
                "platform": s["platform"],
                "speakers": s["speakers"],
                "participants": _participants(
                    _read_session(RECORDINGS / s["sessionId"]) or {}
                ),
                "words": s["words"],
                "cleanup": cleanups[-1]["status"] if cleanups else None,
                "cleaned": _cleaned_brief(s["sessionId"]),
            }
        )
    return out


@mcp.tool()
def get_transcript(session_id: str, cleaned: bool = False) -> str:
    """A meeting's transcript as "[m:ss] Speaker: text" lines, m:ss from the
    start of the recording. cleaned=true returns the cleanup model's copy
    instead (fillers, stutters and false starts removed, punctuation fixed;
    lines its safety check kept as spoken end in "(as spoken)"), when the
    meeting has one (list_meetings says); the original stays the record."""
    session = _read_session(_meeting_dir(session_id))
    if not session:
        raise ToolError(f"no transcript for session {session_id}")
    head = f"Meeting {session_id}, started {_iso(session.get('startedAt'))}, on {session.get('platform')}\nParticipants: {', '.join(_participants(session))}"
    if not cleaned:
        lines = [
            f"[{_clock(s['start'])}] {s['speaker']}: {s['text']}"
            for s in session.get("segments") or []
        ]
        return "\n".join([head, "", *lines])
    copy = _cleaned_copy(session_id, session)
    if copy is None:
        raise ToolError(
            f"session {session_id} has no cleaned copy"
            + ("; clean_transcript makes one" if CLEANUP_URL else "; cleanup is off")
        )
    note = (
        f"Cleaned copy by {copy.get('model') or 'the cleanup model'}, {copy.get('finishedAt')}; "
        f"{copy.get('keptRaw')} line(s) kept as spoken by its safety check"
        + (
            "; the transcript changed since, so it is out of date"
            if copy["stale"]
            else ""
        )
    )
    lines = [
        f"[{_clock(max(0, line['start']))}] {line['speaker']}: {line['text']}".rstrip()
        + (" (as spoken)" if line.get("keptRaw") else "")
        for line in copy["lines"]
    ]
    return "\n".join([head, note, "", *lines])


@mcp.tool()
def clean_transcript(session_id: str) -> dict:
    """Start the cleanup model on a meeting's transcript, or again to replace
    its cleaned copy. It runs in the background (seconds per 250 words);
    this returns the run's status, list_meetings shows progress, and
    get_transcript(cleaned=true) reads the result. The original transcript
    never changes. Only on servers with cleanup configured."""
    folder = _meeting_dir(session_id)
    if not CLEANUP_URL:
        raise ToolError("cleanup is off on this server (SCRIBE_CLEANUP_URL)")
    if not (_read_session(folder) or {}).get("segments"):
        raise ToolError(f"no transcript for session {session_id}")
    return _start_cleanup(session_id)


@mcp.tool()
def search_transcripts(
    query: str, since: str | None = None, until: str | None = None, limit: int = 50
) -> list[dict]:
    """Case-insensitive text search across meeting transcripts, newest meeting
    first. Each hit has the meeting, when in it, who spoke, and the text
    around the match."""
    needle = query.lower().strip()
    if not needle:
        raise ToolError("query is empty")
    hits = []
    for s in _sessions_between(since, until):
        session = _read_session(RECORDINGS / s["sessionId"]) or {}
        for seg in session.get("segments") or []:
            text = seg["text"]
            at = text.lower().find(needle)
            if at < 0:
                continue
            hits.append(
                {
                    "sessionId": s["sessionId"],
                    "startedAt": _iso(s["startedAt"]),
                    "at": _clock(seg["start"]),
                    "speaker": seg["speaker"],
                    "text": text[max(0, at - 300) : at + len(needle) + 300],
                }
            )
            if len(hits) >= limit:
                return hits
    return hits


def _cleanups(session_id):
    """A meeting's cleanup records, oldest first."""
    folder = _meeting_dir(session_id) / "cleanups"
    records = [_read_json(p) for p in folder.glob("*.json")] if folder.is_dir() else []
    return sorted(filter(None, records), key=lambda c: c["startedAt"])


def _summary(c):
    return {k: v for k, v in c.items() if k != "notes"} | {
        "title": (c.get("notes") or {}).get("title")
    }


def _now():
    return datetime.now(UTC).isoformat()


@mcp.tool()
def create_cleanup(session_id: str, model: str, job_id: str | None = None) -> dict:
    """Record that a cleanup of a meeting's transcript has started. Scribe only
    keeps the record: the caller runs the model (job_id is its job, so another
    client can follow it) and reports back with finish_cleanup. A meeting can
    have any number of cleanups; its transcript itself never changes."""
    folder = _meeting_dir(session_id)
    if not (folder / "session.json").exists():
        raise ToolError(f"no transcript for session {session_id}")
    record = {
        "id": uuid.uuid4().hex[:12],
        "status": "running",
        "model": model,
        "jobId": job_id,
        "startedAt": _now(),
    }
    (folder / "cleanups").mkdir(exist_ok=True)
    _write_json(folder / "cleanups" / f"{record['id']}.json", record)
    return record


@mcp.tool()
def finish_cleanup(
    session_id: str,
    cleanup_id: str,
    notes: dict | None = None,
    error: str | None = None,
) -> dict:
    """Finish a cleanup with its notes, or with an error when it failed.
    Conventional note keys: title, summary, updates, decisions, action_items,
    open_questions, and cleaned_transcript ("[m:ss] Speaker: text" lines)."""
    if (notes is None) == (error is None):
        raise ToolError("pass exactly one of notes or error")
    if notes is not None and len(json.dumps(notes)) > MAX_SESSION_BYTES:
        raise ToolError("notes are too large")
    path = _meeting_dir(session_id) / "cleanups" / f"{cleanup_id}.json"
    record = _read_json(path) if re.fullmatch(r"[0-9a-f]{12}", cleanup_id) else None
    if record is None:
        raise ToolError(f"no cleanup {cleanup_id} for session {session_id}")
    record |= {
        "status": "failed" if error else "done",
        "notes": notes,
        "error": error,
        "finishedAt": _now(),
    }
    _write_json(path, record)
    return _summary(record)


@mcp.tool()
def list_cleanups(session_id: str) -> list[dict]:
    """A meeting's cleanups, newest first, without their notes."""
    return [_summary(c) for c in reversed(_cleanups(session_id))]


@mcp.tool()
def get_cleanup(session_id: str, cleanup_id: str | None = None) -> dict | None:
    """One cleanup with its notes; without cleanup_id, the newest finished one.
    Null when there is none."""
    done = [c for c in _cleanups(session_id) if c["status"] == "done"]
    if cleanup_id is None:
        return done[-1] if done else None
    return next((c for c in _cleanups(session_id) if c["id"] == cleanup_id), None)


@mcp.tool(name="get_vocab")
def mcp_get_vocab() -> list[str]:
    """Phrases (names, companies, terms) boosted in every meeting's recognition."""
    return _read_json(VOCAB) or []


@mcp.tool()
def add_vocab(phrases: list[str]) -> list[str]:
    """Add phrases to the boost list and return the whole list. Boost proper
    nouns the recognizer gets wrong; common words can hurt recognition."""
    with _vocab_lock:
        vocab = _clean_phrases((_read_json(VOCAB) or []) + phrases)
        _write_json(VOCAB, vocab)
    return vocab


@mcp.tool()
def remove_vocab(phrases: list[str]) -> list[str]:
    """Remove phrases from the boost list and return the whole list."""
    drop = set(_clean_phrases(phrases))
    with _vocab_lock:
        vocab = [p for p in _read_json(VOCAB) or [] if p not in drop]
        _write_json(VOCAB, vocab)
    return vocab


# Served at /mcp. Mounted last so every route above takes precedence. The SDK's
# own Host check is off: SCRIBE_ALLOWED_HOSTS covers the whole app, /mcp too.
_mcp_app = mcp.streamable_http_app(
    stateless_http=True,
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


@contextlib.asynccontextmanager
async def _lifespan(app):
    async with _mcp_app.router.lifespan_context(app):
        if not WYOMING:
            yield
            return
        host, _, port = WYOMING.rpartition(":")
        server = await asyncio.start_server(
            _wyoming_client, host.strip("[]") or None, int(port)
        )
        print(f"[scribe] wyoming on {WYOMING}", flush=True)
        try:
            yield
        finally:
            server.close()  # without waiting on clients still connected


app.router.lifespan_context = _lifespan
app.mount("", _mcp_app)
