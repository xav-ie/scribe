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
