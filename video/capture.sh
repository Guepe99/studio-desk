#!/usr/bin/env bash
# Runs capture.mjs against the live site with WebGL 2 (SwiftShader in the Playwright image, as tests/web/run-smoke.sh WEBGL=2).
#   ../scripts/with-lock.sh chromium ./capture.sh [shot ...]
set -euo pipefail
cd "$(dirname "$0")"
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
CONT="sd-video-chromium-$$"
trap 'docker stop "$CONT" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$CONT" --shm-size=1g --network host mcr.microsoft.com/playwright:v1.48.0-jammy \
  /ms-playwright/chromium-1140/chrome-linux/chrome --headless=new --no-sandbox --hide-scrollbars \
  --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port="$PORT" about:blank >/dev/null
for _ in $(seq 120); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/json/version" && break; sleep 0.5; done
CDP_URL="http://127.0.0.1:$PORT" node "${SCRIPT:-capture.mjs}" "$@"
