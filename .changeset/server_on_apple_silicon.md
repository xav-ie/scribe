---
default: minor
---

# The server runs on Apple silicon Macs

`server/run.sh` runs the server natively on a Mac's GPU (Metal), with the same model, decoding and vocabulary boosting as on NVIDIA, and transcripts that match the NVIDIA server's. `SCRIBE_DEVICE` picks `cuda`, `mps` or `cpu`; by default the server takes the GPU it finds. On a Mac, `server/launchd.sh install` keeps it running in the background, started at login and restarted if it stops.
