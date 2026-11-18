#!/usr/bin/env bash
# Build the extension and copy it over an unpacked install, which reloads
# itself into the new build within a minute once nothing is recording.
#   scripts/sync.sh host:path/to/extension/dist
set -euo pipefail

dest=${1:?usage: scripts/sync.sh host:path/to/extension/dist}
host=${dest%%:*}
path=${dest#*:}

cd "$(dirname "$0")/.."
pnpm run build >/dev/null
rsync -a --delete dist/ "$dest/"
echo "built:  $(jq -r .version_name dist/manifest.json)"
echo "synced: $(ssh "$host" jq -r .version_name "$path/manifest.json")"
