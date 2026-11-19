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
  rm -f "out/${name}"
  timeout -k 3 25 "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 \
    --window-size=1920,1080 \
    --virtual-time-budget=6000 \
    --user-data-dir="/tmp/yuzhua-still-${id}" \
    --screenshot="out/${name}" \
    "file://${PWD}/stills.html?shot=${id}" || true
  python3 - "$name" <<'PY'
import sys
from pathlib import Path
p = Path("out") / sys.argv[1]
if not p.exists() or p.stat().st_size < 10000:
    raise SystemExit(f"missing screenshot {p}")
print(p.name, p.stat().st_size)
PY
}

shot a dir-a-closeup.png
shot b dir-b-typepunch.png
shot c dir-c-inkfield.png
shot sheet directions-story-a.png
