#!/usr/bin/env bash
# Copy resources/* over Vivaldi's UI files and nuke the stock bundle.
set -euo pipefail

UI_DIR="./vivaldi/resources/vivaldi"

if [[ ! -d "$UI_DIR" ]]; then
  echo "$UI_DIR not found. run ./install.sh first." >&2
  exit 1
fi

cp resources/window.html "$UI_DIR/window.html"
cp resources/ui.js       "$UI_DIR/ui.js"
cp resources/ui.css      "$UI_DIR/ui.css"
cp resources/preload.js  "$UI_DIR/preload.js"

# disable the stock UI bundle so only ours runs
if [[ -f "$UI_DIR/bundle.js" ]]; then
  : > "$UI_DIR/bundle.js"
fi

echo "deployed eyebrow UI to $UI_DIR"
