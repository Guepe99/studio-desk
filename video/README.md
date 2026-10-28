# The submission video

Edited with Remotion from the live site; the script is [docs/VIDEO-SCRIPT.md](../docs/VIDEO-SCRIPT.md).
`public/` (the stills, clips, voice and sound, about 130 MB) is made by the scripts below and is not in git.

| file | what it makes |
|---|---|
| `capture.mjs` | the 1920x1080 stills of the live site in `public/shots/` |
| `clips.mjs` | the 3D clips in `public/clips/`, one frame at a time on Playwright's fake clock |
| `capture.sh` | starts a Chromium with WebGL 2 for either script: `./capture.sh [shot ...]`, `SCRIPT=clips.mjs ./capture.sh [clip ...]` |
| `voice.py`, `voice-jobs.json` | the voice-over, one WAV per line, with Kokoro (`scripts/booth-kokoro-setup.sh`) |
| `src/Root.jsx` | the cut (`studio-desk`) and the YouTube thumbnail (`thumbnail`) |

The crowd sounds in `public/sfx/` are the site's own CC0 recordings from `web/vendor/crowd-audio` ([THIRD_PARTY.md](../THIRD_PARTY.md)); `goal-call.wav` is the booth's own goal call from the replay.
Playwright comes from `PLAYWRIGHT_FROM` (a folder with `node_modules/playwright`).

    npm ci
    npx remotion render src/index.jsx studio-desk out.mp4
    npx remotion still src/index.jsx thumbnail thumbnail.jpg
