# Built on the host at runtime (build-scribe-image.service in module.nix). The
# Python environment is pinned by pyproject.toml + uv.lock (NeMo 3.0.0, torch
# 2.14.0), and its ~3.9 GiB of CUDA wheels live only in podman's store instead
# of the system closure.
# Fully qualified, so it builds without unqualified-search-registries set in
# registries.conf, and pinned by digest (Dependabot proposes updates).
FROM docker.io/library/python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

# soundfile dlopens libsndfile; ca-certificates for the HF model download.
# The CUDA stack ships inside the torch/nvidia-* wheels themselves, so a slim
# (non-CUDA) base + the CDI-injected driver is all that's needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsndfile1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml uv.lock ./
# [tool.uv] package = false → only the pinned dependencies are installed.
RUN pip install --no-cache-dir uv==0.13.0 \
 && uv sync --frozen --no-dev
COPY stream_server.py ui.html ./
# The cleanup model's prompt and safety check, from models/cleanup in the
# checkout, which is outside this build context: build with
#   docker build server --build-context cleanup=models/cleanup
# hadolint ignore=DL3022
COPY --from=cleanup guard.py prompt.txt ./cleanup/

LABEL org.opencontainers.image.title="scribe" \
      org.opencontainers.image.description="Live meeting transcription server: NVIDIA Parakeet streaming ASR, web UI and MCP" \
      org.opencontainers.image.licenses="MIT"

# Model caches, recordings and the vocabulary all live under /cache: mount a
# volume there to keep them across restarts.
ENV PATH="/app/.venv/bin:$PATH" \
    HOME=/tmp \
    HF_HOME=/cache/huggingface \
    NEMO_CACHE_DIR=/cache/nemo \
    NUMBA_CACHE_DIR=/tmp \
    PYTHONWARNINGS=ignore::SyntaxWarning
EXPOSE 8000
CMD ["uvicorn", "stream_server:app", "--host", "0.0.0.0", "--port", "8000"]
