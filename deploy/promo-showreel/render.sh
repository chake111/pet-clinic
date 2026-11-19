#!/usr/bin/env bash
# Rebuild the 1920×1080 hook stills from stills.html.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
# Use the Chrome binary, not the google-chrome wrapper: that wrapper pins one
# profile and debug port, so later shots reuse the first page.
CHROME="${CHROME:-/usr/bin/google-chrome-stable}"

shot() {
  local id="$1" name="$2"
  local profile="/tmp/yuzhua-still-${id}"
  rm -rf "$profile"
  rm -f "out/${name}"
  if ! timeout -k 3 25 "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 \
    --window-size=1920,1080 \
    --virtual-time-budget=6000 \
    --user-data-dir="$profile" \
    --screenshot="out/${name}" \
    "file://${PWD}/stills.html?shot=${id}"
  then
    rm -rf "$profile"
    echo "chrome failed while rendering ${id}" >&2
    exit 1
  fi
  rm -rf "$profile"
  python3 - "$name" <<'PY'
import struct
import sys
from pathlib import Path
p = Path("out") / sys.argv[1]
data = p.read_bytes()
if data[:8] != b"\x89PNG\r\n\x1a\n" or len(data) < 24:
    raise SystemExit(f"{p} is not a PNG")
width, height = struct.unpack(">II", data[16:24])
if (width, height) != (1920, 1080):
    raise SystemExit(f"{p} is {width}x{height}, expected 1920x1080")
print(p.name, f"{width}x{height}", len(data))
PY
}

shot a dir-a-closeup.png
shot b dir-b-typepunch.png
shot c dir-c-inkfield.png
shot sheet directions-story-a.png
