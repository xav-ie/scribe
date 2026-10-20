---
default: minor
---

# The NixOS module can run the cleanup model

`services.scribe.cleanup.server.enable` runs the scribe cleanup model on the same host with llama.cpp from nixpkgs, prompt lookup on, and points scribe at it. It runs on the CPU by default; with a CUDA build of llama.cpp, `gpuLayers` moves it to the GPU. `model` takes a Hugging Face repository or a GGUF file.
