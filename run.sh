#!/usr/bin/env bash
# Launch the modified Vivaldi with an isolated user data dir.
set -euo pipefail

DATA_DIR="$(pwd)/data"
mkdir -p "$DATA_DIR"

BIN="./vivaldi/vivaldi"
if [[ ! -x "$BIN" ]]; then
  echo "$BIN not found. run ./install.sh first." >&2
  exit 1
fi

exec "$BIN" --user-data-dir="$DATA_DIR" "$@"
