#!/usr/bin/env bash
# Restore the original Vivaldi window.html + bundle.js.
set -euo pipefail
UI_DIR="./vivaldi/resources/vivaldi"
[[ -f "$UI_DIR/window.html.orig" ]] && cp "$UI_DIR/window.html.orig" "$UI_DIR/window.html"
[[ -f "$UI_DIR/bundle.js.orig"   ]] && cp "$UI_DIR/bundle.js.orig"   "$UI_DIR/bundle.js"
echo "restored stock vivaldi UI"
