## 0.1.8 (2026-10-27)

### Fixes

#### Patch four more advisories under NeMo's dependency caps

Overrides take hydra-core to 1.3.8 (two RCEs) and fsspec[http] to 2026.6.0 (ReferenceFileSystem SSTI), while pinned bumps bring opentelemetry-api to 1.45.1 (tracestate parsing) and wandb to 0.31.0; lightning stays at 2.4.0 because every nv-one-logger release fails to import against 2.6.x, so that advisory waits on upstream, and the validated environment already runs the patched pytorch-lightning 2.6.6.

#### Refresh dependencies with security fixes

The server's pinned environment moves to FastAPI 0.162 (Starlette 1.10) with patched Pillow, aiohttp, certifi, filelock, and setuptools, and the extension builds on Vite 8.3.4, clearing 68 of 73 open dependency alerts.

## 0.1.7 (2026-10-27)

### Fixes

#### One transport for tab and mic audio

A saved meeting now plays through one transport — a single scrubber and speed menu over every stream, with checkboxes to mute the meeting or your mic — while the transcript runs down a rail spaced by real time and a speaker's chip dims everyone else.

## 0.1.6 (2026-10-22)

### Features

#### Speakers corrected by voice

A new popup option, "Correct speakers by voice", has the server re-check who spoke once the meeting ends: it learns each speaker's voice from the saved audio and moves speech the voice clearly gives to someone else, fixing the moments the meeting's speaker indicator lags or lights the wrong tile. The audio is kept only until that's done unless "Save audio" is on, and cleanup then runs on the corrected transcript. Any session with saved audio can be corrected from the web UI (which lists what changed, each playable) or the `correct_speakers` MCP tool.

### Fixes

#### Web UI favicon is the swirl

The web UI's tab icon is now the snail's shell alone, like the extension's toolbar icon, instead of the whole snail on its circle.

## 0.1.5 (2026-10-22)

### Features

#### Sessions carry the meeting's name

Each session records the meeting's name from its tab title (Meet's calendar event name, for instance). The web UI lists it with each session and heads the session page with it, and the MCP tools return it, ahead of the name the cleanup model makes up.

### Fixes

#### No blank sessions, no lost last words

A recording that failed to start no longer leaves a blank session on the server. Stopping a long recording after Chrome had put the extension's worker to sleep no longer drops its last few words.

#### Debug bundles leave out the access token

A downloaded debug bundle no longer contains the server's access token, which would let anyone you share it with read every meeting. It shows `#token=redacted` instead, so you can still tell one was set.

#### Tab and mic audio play together

On a saved session, the tab and microphone players are linked: playing, pausing or scrubbing one does the same to the other, on the meeting's clock. A "Tracks linked" button unlinks them to play one alone.

#### Resumed sessions in the live view

While a resumed session records, the web UI's live view shows the earlier part's transcript above the live words, and once it stops waits for the combined record instead of showing the earlier part alone.

#### First words after unmuting are kept

The extension notices you unmuting within a tenth of a second instead of up to half a second, so the start of what you say right after unmuting is no longer cut off.

#### The toolbar icon shows when it's recording

The extension's icon shows a red REC badge while recording, and a yellow ! when the last recording ended in an error (such as the server dropping), with the error in its tooltip, until the next recording starts.

#### Meeting audio is saved by default

"Save audio on the streaming service" now starts checked, so a new install keeps each meeting's audio for replay next to its transcript. A choice you already made is kept.

#### Settings page matches the popup

The settings page no longer points to a "Capture my microphone" checkbox in the popup, which was removed when the mic became always recorded.

#### A recording the server ends says why

When the streaming service ends a recording you didn't stop, the popup now says so (with the server's reason) and the toolbar icon shows !, instead of quietly going idle. A server falling behind no longer looks like a missing access token.

#### Closing the meeting tab stops the recording

Closing the meeting tab now ends the recording, instead of leaving it running and still transcribing your microphone. The popup also warns when your microphone can't be opened or its stream drops, rather than quietly leaving your voice out.

## 0.1.4 (2026-10-21)

### Features

#### Restarting in the same meeting resumes its session

Each session now records its meeting's address (without the query, where Zoom keeps the passcode). Starting a recording in the same meeting within 30 minutes of stopping carries on in that session: one transcript, one set of saved audio with a stream per part, and one record on the server.

### Fixes

#### Meet speakers detected again

Meet now animates the active speaker's audio meter inside a hidden layer, which the extension skipped, so a Meet recording stayed on whoever was detected first. Hidden meters count again, and the speaking rate alone tells the speaker apart.

#### Tidier popup

The options now sit above the record button, the streaming service address is gone (it's on the settings page), and Settings and the debug bundle are links at the bottom.

#### Save audio is set before recording

The "Save audio on the streaming service" checkbox is locked while recording, since a change only applies from the next recording.

#### No false "speaker detection is not running" warning

Recording in a meeting tab opened before the extension was reloaded no longer warns that speaker detection isn't running when it starts a moment later.

## 0.1.3 (2026-10-21)

### Fixes

#### Zoom speakers in picture-in-picture

Switching away from a Zoom tab no longer stops speaker detection. Zoom moves the call into a picture-in-picture window, and the extension now follows it there for the active speaker and your mute state, as it already did for Meet.

## 0.1.2 (2026-10-20)

### Features

#### Your mic is always recorded

The popup's "Capture my microphone" checkbox is gone: once mic access is granted, every recording includes your mic as its own stream, still silenced while you're muted in the meeting.

### Fixes

#### Speakers in the web UI's live view

A meeting still recording now shows in the web UI as speaker turns, like the extension's popup, instead of each stream's words in one block. The extension sends its active speaker timeline along with the tab audio, so both need updating.

## 0.1.1 (2026-10-20)

### Features

#### Wyoming speech to text for Home Assistant

Set `SCRIBE_WYOMING` to a host and port (e.g. `0.0.0.0:10300`) and scribe also serves the Wyoming protocol, so Home Assistant's voice assistants can use it for speech to text. Commands are boosted with the vocabulary, like the OpenAI-compatible endpoint.

### Fixes

#### Cleanup cuts recognition loops first

When speech-to-text repeats a word or short phrase 5 or more times in a row ("two two two ..."), scribe now cuts the run to one copy before the cleanup model sees it, as the model was trained to. A long loop could make the model repeat it instead, which left the whole chunk uncleaned. A line the safety check keeps still shows what was said, loop and all.

## 0.1.0 (2026-10-20)

### Features

#### Nix on Macs

`nix run github:xav-ie/scribe#server` runs the server on an Apple silicon Mac and `#cleanup-server` the cleanup model. The new nix-darwin module, `darwinModules.default`, runs both as login agents: `services.scribe.enable`, and `services.scribe.cleanup.enable` for cleanup.

#### The NixOS module can run the cleanup model

`services.scribe.cleanup.server.enable` runs the scribe cleanup model on the same host with llama.cpp from nixpkgs, prompt lookup on, and points scribe at it. It runs on the CPU by default; with a CUDA build of llama.cpp, `gpuLayers` moves it to the GPU. `model` takes a Hugging Face repository or a GGUF file.

#### Optional transcript cleanup

Point `SCRIBE_CLEANUP_URL` at a server running the scribe cleanup model and each meeting gets a cleaned copy when its recording ends: ums, stutters and false starts removed, punctuation and capitals fixed, every other word, speaker, timestamp and number kept. The original transcript never changes. A safety check keeps the original line wherever the model changed a number, a "not", a speaker or a timestamp. The web UI shows the cleaned copy beside the original and cleans older meetings on request; MCP agents read it with `get_transcript(cleaned=true)` and start one with `clean_transcript`. On a Mac, `models/cleanup/serve_mlx.py` serves the model with prompt lookup, about 1.5 times faster than `mlx_lm.server`, and `server/launchd.sh install --cleanup` runs it beside the server and turns cleanup on.

#### The server runs on Apple silicon Macs

`server/run.sh` runs the server natively on a Mac's GPU (Metal), with the same model, decoding and vocabulary boosting as on NVIDIA, and transcripts that match the NVIDIA server's. `SCRIBE_DEVICE` picks `cuda`, `mps` or `cpu`; by default the server takes the GPU it finds. On a Mac, `server/launchd.sh install` keeps it running in the background, started at login and restarted if it stops.

#### First release

The Chrome extension streams Google Meet and Zoom calls to your scribe server and shows live captions with every speaker named. This release brings an orange-brown and recording red theme that passes WCAG AA, a settings page that explains the server and microphone permissions before asking, and no default server.
