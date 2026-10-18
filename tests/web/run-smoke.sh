#!/usr/bin/env bash
# Serves web/ and runs tests/web/smoke.mjs against it on the DEMO fixture.
# On this server Playwright's own Chromium misses system libraries, so the browser runs in the
# foto-chromium:1 docker image (~/bin/pagine/Dockerfile) and Playwright connects over CDP.
# Elsewhere (CDP=0) Playwright launches its own Chromium.
#
#   scripts/with-lock.sh chromium tests/web/run-smoke.sh [script.mjs [args...]]
#
# The optional script (default smoke.mjs, in tests/web/) gets the page base URL as its first
# argument. Those scripts get WebGL 1 from Mesa's software Vulkan driver (tests/web/webgl).
# WEBGL=2 runs Playwright's own Chromium inside the official Playwright image instead, where
# SwiftShader gives WebGL 2 with 4x MSAA: the 3D scene's high quality profile is tested there.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }

[ -f "$ROOT/web/data/DEMO/meta.json" ] || "$ROOT/.venv/bin/python" "$ROOT/scripts/make_demo_fixture.py" 2>/dev/null \
  || python3 "$ROOT/scripts/make_demo_fixture.py"

WEB=$(free_port)
python3 -m http.server "$WEB" --bind 127.0.0.1 --directory "$ROOT/web" >/dev/null 2>&1 &
SERVER=$!
CONT="sd-smoke-chromium-$$"
cleanup() { kill "$SERVER" 2>/dev/null || true; docker stop "$CONT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

SCRIPT=${1:-smoke.mjs}
shift || true
# WebGL pages (anything but the 2D smoke test) need the image with the software Vulkan driver.
WEBGL=${WEBGL:-$([ "$SCRIPT" = smoke.mjs ] && echo 0 || echo 1)}
if [ "${CDP:-1}" = 1 ]; then
  CDPPORT=$(free_port)
  IMAGE=foto-chromium:1
  GL=(--disable-gpu)
  BIN=chromium-browser
  if [ "$WEBGL" = 1 ]; then
    IMAGE=sd-chromium-webgl:1
    docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -t "$IMAGE" "$ROOT/tests/web/webgl" >/dev/null
    GL=(--use-gl=angle --use-angle=vulkan --enable-unsafe-swiftshader --ignore-gpu-blocklist)
  elif [ "$WEBGL" = 2 ]; then
    IMAGE=mcr.microsoft.com/playwright:v1.48.0-jammy
    BIN=/ms-playwright/chromium-1140/chrome-linux/chrome
    GL=(--headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist)
  fi
  docker run -d --rm --name "$CONT" --shm-size=1g --network host "$IMAGE" \
    "$BIN" --headless --no-sandbox --hide-scrollbars "${GL[@]}" \
    --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CDPPORT" about:blank >/dev/null
  for _ in $(seq 60); do curl -sf -o /dev/null "http://127.0.0.1:$CDPPORT/json/version" && break; sleep 0.5; done
  export CDP_URL="http://127.0.0.1:$CDPPORT"
fi
for _ in $(seq 20); do curl -sf -o /dev/null "http://127.0.0.1:$WEB/index.html" && break; sleep 0.25; done
node "$ROOT/tests/web/$SCRIPT" "http://127.0.0.1:$WEB/" "$@"
