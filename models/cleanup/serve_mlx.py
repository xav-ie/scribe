#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["mlx-lm>=0.32,<0.33"]  # tested with 0.32; it uses mlx-lm cache internals
# ///
"""The cleanup model on a Mac, with prompt lookup: an OpenAI-compatible server for scribe's SCRIBE_CLEANUP_URL.

  models/cleanup/serve_mlx.py [--model xav-ie/scribe-cleanup-mlx-4bit] [--port 8080]

Cleaned text mostly repeats its input, so instead of one token per model step it guesses the next tokens by finding
the last few output tokens in the input and copying what follows, then checks the whole guess in one step and keeps
the part the model agrees with. That takes far fewer steps than plain decoding; mlx_lm.server has no such option.
Decoding is always greedy (temperature 0), as cleanup wants. Requests run one at a time, on the thread that loaded
the model, as MLX requires.
"""
import argparse, json, time
from http.server import BaseHTTPRequestHandler, HTTPServer

import mlx.core as mx
from mlx_lm import load
from mlx_lm.models.cache import KVCache, RotatingKVCache, trim_prompt_cache

N, M = 3, 16  # match the last 3 tokens; guess up to 16


def make_cache(model, size=8192):
    """Gemma's sliding-window layers use a rolling cache that can't be wound back once it wraps; one big enough never
    wraps (the attention mask still limits those layers to their window), so rejected guesses can be trimmed."""
    return [RotatingKVCache(max_size=size, keep=getattr(c, "keep", 0)) if isinstance(c, RotatingKVCache) else KVCache()
            for c in model.make_cache()]


def generate(model, prompt, eos, max_new, kept):
    """kept = [cache, tokens in it] from the last request: the part its prompt shares with this one (the system
    prompt, at least) is reused instead of recomputed."""
    cache, seen = kept
    same = 0
    while same < min(len(seen), len(prompt) - 1) and seen[same] == prompt[same]:
        same += 1
    trim_prompt_cache(cache, len(seen) - same)
    out = [int(mx.argmax(model(mx.array(prompt[same:])[None], cache=cache)[0, -1]))]
    while out[-1] not in eos and len(out) < max_new:
        tail, draft = (prompt + out)[-N:], []
        for i in range(len(prompt) - N, -1, -1):  # the latest match in the input
            if prompt[i:i + N] == tail:
                draft = prompt[i + N:i + N + M][: max_new - len(out) - 1]
                break
        step = [out[-1]] + draft
        preds = mx.argmax(model(mx.array(step)[None], cache=cache)[0], axis=-1).tolist()
        k = 0
        while k < len(draft) and preds[k] == draft[k]:
            k += 1
        out += draft[:k] + [preds[k]]
        trim_prompt_cache(cache, len(step) - (k + 1))  # forget the rejected guesses
    kept[1] = prompt + out[:-1]  # the last token was never fed to the model
    for i, t in enumerate(out):
        if t in eos:
            return out[:i], "stop"
    return out[:max_new], "length"


ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--model", default="xav-ie/scribe-cleanup-mlx-4bit")
ap.add_argument("--host", default="127.0.0.1")
ap.add_argument("--port", type=int, default=8080)
args = ap.parse_args()
model, tok = load(args.model)
eos = set(getattr(tok, "eos_token_ids", None) or [tok.eos_token_id])
kept = [make_cache(model), []]


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/health", "/v1/models"):
            return self.reply(200, {"object": "list", "data": [{"id": args.model, "object": "model"}]})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            return self.reply(404, {"error": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            kwargs = {"enable_thinking": False, **(req.get("chat_template_kwargs") or {})}
            prompt = tok.apply_chat_template(req["messages"], add_generation_prompt=True, **kwargs)
            max_new = int(req.get("max_tokens") or 1024)
        except (ValueError, KeyError, TypeError) as e:
            return self.reply(400, {"error": f"bad request: {e}"})
        try:
            out, finish = generate(model, prompt, eos, max_new, kept)
        except Exception:
            kept[:] = [make_cache(model), []]  # the cache's contents are unknown now
            raise
        self.reply(200, {
            "id": f"chatcmpl-{time.time_ns()}", "object": "chat.completion", "created": int(time.time()), "model": args.model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": tok.decode(out)}, "finish_reason": finish}],
            "usage": {"prompt_tokens": len(prompt), "completion_tokens": len(out), "total_tokens": len(prompt) + len(out)},
        })

    def log_message(self, fmt, *a):
        pass


print(f"serving {args.model} on http://{args.host}:{args.port}/v1", flush=True)
HTTPServer((args.host, args.port), Handler).serve_forever()
