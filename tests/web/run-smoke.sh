#!/usr/bin/env bash
# Serves web/ and runs tests/web/smoke.mjs against it on the DEMO fixture.
# On this server Playwright's own Chromium misses system libraries, so the browser runs in the
# foto-chromium:1 docker image (~/bin/pagine/Dockerfile) and Playwright connects over CDP.
# Elsewhere (CDP=0) Playwright launches its own Chromium.
#
#   scripts/with-lock.sh chromium tests/web/run-smoke.sh
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

if [ "${CDP:-1}" = 1 ]; then
  CDPPORT=$(free_port)
  docker run -d --rm --name "$CONT" --shm-size=1g --network host foto-chromium:1 \
    chromium-browser --headless --no-sandbox --disable-gpu --hide-scrollbars \
    --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CDPPORT" about:blank >/dev/null
  for _ in $(seq 60); do curl -sf -o /dev/null "http://127.0.0.1:$CDPPORT/json/version" && break; sleep 0.5; done
  export CDP_URL="http://127.0.0.1:$CDPPORT"
fi
for _ in $(seq 20); do curl -sf -o /dev/null "http://127.0.0.1:$WEB/index.html" && break; sleep 0.25; done
node "$ROOT/tests/web/smoke.mjs" "http://127.0.0.1:$WEB/"
