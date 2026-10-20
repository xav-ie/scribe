---
default: minor
---

# Nix on Macs

`nix run github:xav-ie/scribe#server` runs the server on an Apple silicon Mac and `#cleanup-server` the cleanup model. The new nix-darwin module, `darwinModules.default`, runs both as login agents: `services.scribe.enable`, and `services.scribe.cleanup.enable` for cleanup.
