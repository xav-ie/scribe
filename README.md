<picture><source media="(prefers-color-scheme: light)" srcset="assets/logo/scribe-light.svg"><img align="right" src="assets/logo/scribe.svg" width="120" alt="scribe logo: a snail whose shell is a spiraling sound wave"></picture>

# scribe

**Live meeting transcription on your own GPU, with every speaker named.** A
Chrome extension streams your Google Meet or Zoom call to a self-hosted
recognition server and shows captions as people talk. Every meeting is kept,
searchable by you and by your AI agents.

![The extension's popup over a Google Meet call, showing the live transcript with each line labeled by speaker](assets/screenshot.png)

- **Real names, not "Speaker 2".** Each word is labeled with whoever the meeting
  showed as speaking, and your own mic is labeled as you.
- **Private and fast.** NVIDIA Parakeet streaming recognition on your GPU;
  audio never leaves your network, and captions arrive within about a second.
- **Names and jargon spelled right.** A vocabulary you keep, plus each
  meeting's participant names, is boosted during recognition.
- **Every meeting kept.** Replay audio next to its transcript, or follow a
  recording live, in the server's web UI.
- **Ready for agents.** An MCP server lets AI agents list, read and search
  transcripts, keep notes on them, and edit the vocabulary.
- **An OpenAI-compatible transcription API.** `POST /v1/audio/transcriptions`
  puts the same model behind any dictation tool that speaks the OpenAI API.

## How it works

![The meeting tab feeds audio and the active speaker to the extension, which streams audio to the scribe server over a WebSocket and gets words with timestamps back; the server's sessions are available to the web UI, MCP agents and the OpenAI-compatible API](assets/how-it-works.png)

The server sends back every word with its timing, and the extension labels it
with whoever the meeting showed as speaking at that moment.

## Quick start

You need a Linux machine with an NVIDIA GPU and the NVIDIA container toolkit
for the server, and Chrome or another Chromium browser for the extension.

1. **Run the server.** The model downloads on first start.

   ```sh
   podman build -t scribe server
   podman run --device nvidia.com/gpu=all -p 127.0.0.1:8000:8000 -v scribe:/cache \
     -e HF_HOME=/cache/huggingface -e NEMO_CACHE_DIR=/cache/nemo scribe
   ```

   (`docker run --gpus all ...` works the same; on NixOS, see below.)

2. **Install the extension.** Build it, then in `chrome://extensions` turn on
   Developer mode, click **Load unpacked** and pick `extension/dist`.

   ```sh
   cd extension && pnpm install && pnpm build
   ```

   Its settings page opens: enter your server, e.g. `ws://localhost:8000/ws`.

3. **Record.** Join a Meet or Zoom call in Chrome, open the extension and click
   **Start recording**. Browse saved meetings at `http://localhost:8000`.

> [!WARNING]
> The server has **no authentication**: anyone who can reach it can stream
> audio and read every transcript. Keep it on a private network or behind an
> authenticating proxy, and set `SCRIBE_ALLOWED_HOSTS` to the host names you
> serve it under.

<details>
<summary><b>NixOS module</b></summary>

```nix
{
  inputs.scribe.url = "github:xav-ie/scribe";

  outputs = { nixpkgs, scribe, ... }: {
    nixosConfigurations.gpu-host = nixpkgs.lib.nixosSystem {
      modules = [
        scribe.nixosModules.default
        {
          services.scribe.enable = true;
          # services.scribe.dataDir = "/var/lib/scribe"; # model cache, recordings, vocabulary
          # Refuse requests for other host names (DNS rebinding); empty allows any.
          services.scribe.allowedHosts = [ "scribe.example.com" "localhost" ];
          # The container listens on 8000; publishing it is up to you.
          virtualisation.oci-containers.containers.scribe.ports = [ "127.0.0.1:8000:8000" ];
        }
      ];
    };
  };
}
```

The module builds the image on the host (`build-scribe-image.service`), so the
multi-GB CUDA environment stays out of the Nix store, and runs it with podman
and the NVIDIA container toolkit.

</details>

<details>
<summary><b>Server reference</b>: routes, streaming protocol, configuration</summary>

| Route                           |                                                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                         | Web UI: saved sessions with audio playback, live view of a recording in progress, the vocabulary editor.                                                       |
| `WS /ws`                        | Streaming recognition (protocol below).                                                                                                                        |
| `WS /ws/watch/<sessionId>`      | Follow a session's streams live, as the web UI does.                                                                                                           |
| `POST /v1/audio/transcriptions` | OpenAI-style batch transcription of an uploaded clip; replies `{"text"}`.                                                                                      |
| `/api/sessions`, `/api/vocab`   | The JSON API behind the web UI.                                                                                                                                |
| `/mcp`                          | MCP server (streamable HTTP): `list_meetings`, `get_transcript`, `search_transcripts`, cleanups (notes an agent made from a transcript), and vocabulary tools. |

### Streaming protocol

A client opens `/ws` and sends one JSON text message first:

```json
{
  "sampleRate": 48000,
  "sessionId": "<uuid>",
  "channel": "tab",
  "save": false,
  "boost": ["Ada Lovelace"]
}
```

Only `sampleRate` is required, and it must be a common rate (8, 11.025, 12,
16, 22.05, 24, 32, 44.1, 48, 88.2 or 96 kHz). `sessionId` (a UUID) groups the streams of one
meeting for the web UI; `channel` is `tab` or `mic`; `save` keeps the audio and
words under `recordings/<sessionId>/`; `boost` adds phrases (participant names)
to the vocabulary for this stream. Then it sends raw mono int16 little endian
PCM at that rate as binary messages.

The server answers with word updates:

```json
{
  "type": "words",
  "from": 3,
  "words": [{ "word": "hello", "start": 1.28, "end": 1.6 }]
}
```

Replace your words from index `from` on with `words`. Only the last word you
already have can still change (a word split across chunks), so an update never
resends the rest. Times are seconds from the stream's first sample. Send
`{"type": "end"}` to flush the audio still buffered; the server replies with the
final update and `{"type": "done"}`.

### Configuration

Environment variables, documented at the top of
[`server/stream_server.py`](server/stream_server.py): the model, context sizes,
boosting strength, where recordings and the vocabulary live, and
`SCRIBE_ALLOWED_HOSTS`. Browser pages on other sites can't open the server's
WebSockets (their Origin must match the Host, so a reverse proxy should pass
the Host header through, e.g. nginx's `proxy_set_header Host $host`).

</details>

## Development

```sh
nix develop                  # python + pytest, ruff, nixfmt, node, pnpm
nix flake check              # ruff, nixfmt, server tests, module eval
pytest server/tests          # the server's tests on their own (no GPU: the ML stack is stubbed)
cd extension && pnpm i && pnpm check && pnpm build
pnpm screenshot               # regenerate the README images
knope document-change         # note a change for the next release (from the repo root)
```

The server tests cover the HTTP and WebSocket protocol, saving, watchers,
boosting and the MCP tools with a fake recognizer; recognition quality itself
needs a GPU and real audio.

## License

MIT
