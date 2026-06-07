#!/usr/bin/env bash
# Copy a system Vivaldi install into ./vivaldi/ and stage our UI.
set -euo pipefail

SRC="${VIVALDI_SRC:-/opt/vivaldi}"
DST="./vivaldi"

if [[ ! -d "$SRC" ]]; then
  echo "vivaldi install not found at $SRC" >&2
  echo "set VIVALDI_SRC=/path/to/vivaldi and re-run" >&2
  exit 1
fi

if [[ -d "$DST" ]]; then
  echo "$DST already exists. remove it first if you want a fresh copy."
else
  echo "copying $SRC -> $DST (this takes a moment)"
  cp -r "$SRC" "$DST"
fi

UI_DIR="$DST/resources/vivaldi"
if [[ ! -f "$UI_DIR/window.html.orig" && -f "$UI_DIR/window.html" ]]; then
  cp "$UI_DIR/window.html" "$UI_DIR/window.html.orig"
fi
if [[ ! -f "$UI_DIR/bundle.js.orig" && -f "$UI_DIR/bundle.js" ]]; then
  cp "$UI_DIR/bundle.js" "$UI_DIR/bundle.js.orig"
fi

./deploy.sh
echo
echo "done. launch with: ./run.sh"
