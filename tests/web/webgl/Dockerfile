# foto-chromium:1 plus Mesa's software Vulkan driver (lavapipe), so headless Chromium gets WebGL 1
# through ANGLE: the Alpine Chromium build ships no SwiftShader. run-smoke.sh builds it on demand
# (docker build -t sd-chromium-webgl:1 tests/web/webgl) when WEBGL=1.
FROM foto-chromium:1
RUN apk add --no-cache mesa-vulkan-swrast
