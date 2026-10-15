#!/usr/bin/env bash
# tsc over scribe-desktop, failing only on errors in its own files. The AGS and
# gnim libraries ship TypeScript sources (not declarations), so tsc checks them
# too, and they don't pass strict mode against current GObject types; those
# errors are counted, not fatal.
set -uo pipefail
cd "$(dirname "$0")/.."

out=$(tsc --pretty false)
status=$?
[ "$status" -eq 0 ] && exit 0

# Diagnostics start at column 0 with their file; ours are paths in this
# directory, the libraries' resolve through node_modules into the Nix store.
own=$(grep -E '^[A-Za-z][^:]*\([0-9]+,[0-9]+\): error' <<<"$out")
library=$(grep -cE '^\.\./.*\([0-9]+,[0-9]+\): error' <<<"$out")
if [ -n "$own" ]; then
  echo "$own"
  exit 1
fi
echo "scribe-desktop typechecks ($library errors inside the AGS libraries ignored)"
