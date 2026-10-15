#!/usr/bin/env bash
# Generate the GObject types tsc needs, for only the namespaces scribe-desktop
# imports (and what they depend on), then link the AGS JS library. Run inside
# `nix develop .#desktop`, which provides GIR_PATH and AGS_JS.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${GIR_PATH:?run inside nix develop .#desktop}"
: "${AGS_JS:?run inside nix develop .#desktop}"

gir_args=()
IFS=: read -ra dirs <<<"$GIR_PATH"
for dir in "${dirs[@]}"; do gir_args+=(-g "$dir"); done

ts-for-gir generate Astal-4.0 AstalIO-0.1 Gtk-4.0 Soup-3.0 Pango-1.0 cairo-1.0 \
  --ignoreVersionConflicts --outdir @girs "${gir_args[@]}"

mkdir -p node_modules
ln -sfn "$AGS_JS" node_modules/ags
ln -sfn "$AGS_JS/node_modules/gnim" node_modules/gnim
