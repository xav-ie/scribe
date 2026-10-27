---
default: patch
---

# Patch four more advisories under NeMo's dependency caps

Overrides take hydra-core to 1.3.8 (two RCEs) and fsspec[http] to 2026.6.0 (ReferenceFileSystem SSTI), while pinned bumps bring opentelemetry-api to 1.45.1 (tracestate parsing) and wandb to 0.31.0; lightning stays at 2.4.0 because every nv-one-logger release fails to import against 2.6.x, so that advisory waits on upstream, and the validated environment already runs the patched pytorch-lightning 2.6.6.
