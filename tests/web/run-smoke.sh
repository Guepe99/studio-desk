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
# wait_for URL TRIES WHAT: polls every 0.5 s, and stops the run with a message when WHAT never answers
wait_for() {
  for _ in $(seq "$2"); do curl -sf --max-time 2 -o /dev/null "$1" && return 0; sleep 0.5; done
  echo "run-smoke: $3 did not answer at $1 within $(($2 / 2)) s" >&2
  exit 1
}
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }

# rebuild the fixture when it is missing or older than its script; a failure stops the run
FIXTURE="$ROOT/web/data/DEMO/meta.json" GEN="$ROOT/scripts/make_demo_fixture.py"
PY="$ROOT/.venv/bin/python"
[ -x "$PY" ] || PY=python3
if [ ! -f "$FIXTURE" ] || [ "$GEN" -nt "$FIXTURE" ] || [ "$ROOT/scripts/demo_stories.py" -nt "$FIXTURE" ]; then (cd "$ROOT" && "$PY" "$GEN"); fi

SCRIPT=${1:-smoke.mjs}
shift || true
WEB=$(free_port)
if [ "$SCRIPT" = desk.mjs ]; then
  # the desk needs the API (sessions, decisions); runtime rows go to data/runtime.sqlite
  (cd "$ROOT" && exec "$PY" -m uvicorn studiodesk.api:app --host 127.0.0.1 --port "$WEB" >/dev/null 2>&1) &
elif [ "$SCRIPT" = ask-voice.mjs ]; then
  # the API with a stand-in model and a Speech stub (nothing reaches Azure)
  (cd "$ROOT" && PYTHONPATH="$ROOT" exec "$PY" tests/web/ask_voice_server.py "$WEB" >/dev/null 2>&1) &
else
  python3 -m http.server "$WEB" --bind 127.0.0.1 --directory "$ROOT/web" >/dev/null 2>&1 &
fi
SERVER=$!
CONT="sd-smoke-chromium-$$"
cleanup() { kill "$SERVER" 2>/dev/null || true; docker stop "$CONT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# WebGL pages (anything but the 2D pages) need the image with the software Vulkan driver.
# voice.mjs needs MP3 decoding, which the foto-chromium build lacks: it runs in the Playwright image.
WEBGL=${WEBGL:-$(case "$SCRIPT" in smoke.mjs|desk.mjs|ask-voice.mjs) echo 0 ;; voice.mjs) echo 2 ;; *) echo 1 ;; esac)}
if [ "${CDP:-1}" = 1 ]; then
  CDPPORT=$(free_port)
  IMAGE=foto-chromium:1
  GL=(--disable-gpu)
  # ask-voice.mjs: Chromium's fake microphone (a beep) and no permission prompt
  [ "$SCRIPT" = ask-voice.mjs ] && GL+=(--use-fake-device-for-media-stream --use-fake-ui-for-media-stream)
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
  wait_for "http://127.0.0.1:$CDPPORT/json/version" 60 "Chromium in $IMAGE"
  export CDP_URL="http://127.0.0.1:$CDPPORT"
fi
wait_for "http://127.0.0.1:$WEB/index.html" 20 "the web server"
node "$ROOT/tests/web/$SCRIPT" "http://127.0.0.1:$WEB/" "$@"
