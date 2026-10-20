#!/usr/bin/env bash
# Run the scribe server without a container: on a Mac with Apple silicon, or
# on Linux with an NVIDIA GPU. uv installs the pinned environment on first run,
# and the model downloads on first start.
#
#   server/run.sh                     listens on 127.0.0.1:8000
#   SCRIBE_PORT=9000 server/run.sh
#
# Recordings, the vocabulary and the access token live in SCRIBE_DATA
# (default ~/.local/share/scribe); every SCRIBE_* setting in stream_server.py
# can still be set in the environment.
set -euo pipefail
cd "$(dirname "$0")"

data=${SCRIBE_DATA:-$HOME/.local/share/scribe}
mkdir -p "$data"
export SCRIBE_RECORDINGS=${SCRIBE_RECORDINGS:-$data/recordings}
export SCRIBE_VOCAB=${SCRIBE_VOCAB:-$data/vocab.json}
if [ -z "${SCRIBE_TOKEN:-}" ] && [ -z "${SCRIBE_TOKEN_FILE:-}" ]; then
  if [ ! -s "$data/token" ]; then
    (umask 077 && openssl rand -hex 32 >"$data/token")
    echo "[scribe] new access token in $data/token"
  fi
  export SCRIBE_TOKEN_FILE=$data/token
fi
export SCRIBE_ALLOWED_HOSTS=${SCRIBE_ALLOWED_HOSTS:-localhost,127.0.0.1}
export PYTHONWARNINGS=${PYTHONWARNINGS:-ignore::SyntaxWarning}

exec uv run --frozen --no-dev uvicorn stream_server:app \
  --host "${SCRIBE_HOST:-127.0.0.1}" --port "${SCRIBE_PORT:-8000}"
