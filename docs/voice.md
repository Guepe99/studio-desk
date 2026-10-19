# Voice-over

The replay can speak its stories in English, Italian and Spanish. The clips are made beforehand with Azure Speech
(F0 free tier) from the verified story texts, committed in `replays/<match>/`, and played by the
broadcast page when a story goes on air for the visitor. No speech is generated at view time.

## Voices

One voice per language, the same for every story:

| language | voice |
|---|---|
| `en` | `en-US-Ava:DragonHDLatestNeural` |
| `it` | `it-IT-Isabella:DragonHDLatestNeural` |
| `es` | `es-ES-Ximena:DragonHDLatestNeural` |

English: `en-US-Ava:DragonHDLatestNeural`, chosen by ear by the project owner
on 19 Oct 2026 against `en-US-Andrew:DragonHDLatestNeural` and `en-GB-OllieMultilingualNeural`
(the same sentence read by each). The HD voices work on the F0 tier of our resource.

HD voices take no `mstts:express-as` styles and pick their tone from the text, so the SSML is the
verified text alone, with no style or prosody tags. Azure has no English voice with a sports
commentary style: only `zh-CN-YunjianNeural` lists `sports-commentary` (checked on 19 Oct 2026
with the `voices/list` endpoint of our Sweden Central resource;
[language support](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts),
[SSML voice](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice)).

Italian and Spanish (19 Oct 2026, from the same `voices/list` of our resource): each language has two
Dragon HD voices, a woman's and a man's (`it-IT-Isabella` and `it-IT-Alessio`, `es-ES-Ximena` and
`es-ES-Tristan`), and none of the it-IT or es-ES voices lists a sports style. We took the HD
voices, the family the owner chose for English, which work on F0 like Ava, and the woman's voice
in both, so the desk keeps one presenter across the three languages instead of
changing persona when the viewer changes language. Isabella's standard voice is tagged for news
and narration, Ximena's multilingual one for narration; neither tag is a commentary style. The
Spain Spanish voice matches the phrasebook, which is written in Spain Spanish ("el área pequeña",
"zapatazo"). Not chosen: the `MAI-Voice-2` voices (`it-IT-Luca`, `es-ES-Marta`), whose `excited` and
`shouting` styles would suit a goal, because they are a different, newer family we have not
priced or tried on F0; worth a listen if the owner wants more energy. Nobody has listened to the
Italian and Spanish clips yet: the owner should, as for English.

## What is read

`python -m studiodesk.voice <match> [--lang en] [--src DIR] [--out DIR] [--dry-run]`

- Source: `replays/<match>/stories.json` when the AI pack is there, else
  `web/data/<match>/stories.json`, or `--src`.
- Eligible stories: verifier `pass`, `rewritten` or `template`. Template lines are voiced too:
  code builds them from the fact ledger, so they are verified like the rest. Default status
  `auto_approved` or `needs_review` (the page decides per visitor whether a story is on air),
  safety not `flagged`.
- The text is the verified `texts[lang]`, with pronunciations only. English: `2-1` is read
  "two-one", `0` in a score "nil", `6.1/10` "6.1 out of 10", `73'` "minute 73", `km/h` and `m` in
  full. Italian and Spanish: `2-1` is "2 a 1", `4-4-2` "quattro-quattro-due" / "cuatro-cuatro-dos",
  `5,5/10` "5,5 su 10" / "5,5 sobre 10", `45+2` "45 più 2" / "45 más 2", `km/h`, `m/s` and `m` in
  full, and the minute mark is dropped ("al 73'" is read "al 73"). In every language a recap's
  scorer minutes, "(10', 13')", are read "(minutes 10 and 13)", "(minuti 10 e 13)", "(minutos 10 y
  13)". Only signs are spelled out; no content is added or removed.
- Each manifest row also keeps `spoken_sha1`, the SHA-1 of what the voice was sent, so a changed
  pronunciation rule voices the clips it changes again, and only those.
- One request every 3.1 s (F0: 20 requests a minute); a 429 waits for `Retry-After`.
- Output: `replays/<match>/voice/<story_id>.<lang>.mp3` (24 kHz mono, 48 kbps) and
  `replays/<match>/voice.json`, one row per clip:
  `{story_id, lang, file, duration_s, text_sha1, voice}`, `file` relative to the match folder.
- A rerun skips a story whose `text_sha1` and voice are unchanged, and deletes the clips of stories
  that left the replay. When the AI pack for a match is regenerated, run the script again: only
  the changed texts are sent to Azure.
- Key: `key1` of `studiodesk-speech`, read at run time from the Azure CLI (or `SPEECH_KEY`), never
  written to disk. Entra ID tokens need a custom subdomain, which this F0 resource does not have.
- One run per language (`--lang en|it|es`); a run keeps the manifest rows and clips of the other
  languages.

## In the image

`Dockerfile` copies `replays/` and lays each `replays/<m>/` over `web/data/<m>/` after the
export, so `voice.json` and `voice/` land next to the replay files. To try it locally without
Docker, symlink them: `ln -s ../../../replays/M001/voice.json web/data/M001/` and the same for
`voice/` (the static server of the tests follows symlinks; the API's StaticFiles does not).

## In the page (`web/js/voice.js`)

- A speaker button in the controls bar, labelled "AI voice-over" so a listener knows the voice is
  synthetic ([Microsoft, disclosure design patterns](https://learn.microsoft.com/en-us/legal/cognitive-services/speech-service/custom-neural-voice/concepts-disclosure-patterns)).
  Off by default; the press is the user gesture browsers need before audio. The choice is kept
  in `localStorage`. Hidden when the replay has no clips.
- A story speaks once, when its card (the why_card showing the text the clip says) appears on screen (the OGraf host's `live` set), at 1x,
  in the language the viewer picked, with that language's clip (`<story_id>.<lang>.mp3`); a story
  with no clip in that language stays silent rather than speak another language. Held, rejected and AI-off stories never reach the screen, so they
  never speak; the module also asks `desk.onAir()` every frame and stops a clip whose story leaves
  the air (reject, AI switch off).
- An edited story stays silent: the clip would say the old text. A clip whose `text_sha1` does not
  match the story text the page loaded is never played.
- One clip at a time. A story that comes up while another speaks waits; it is dropped if it would
  start more than 4 s of match time after its cue. Only one story waits: a newer one takes its
  place, so the voice stays with the latest moment and the older card stays silent.
- Seeking stops the clip; a speed other than 1x, a language change or the mute button stop it; a
  pause pauses it. At full time the recap finishes even though the replay has stopped.
- The 3D sample page (`web/sample3d.html`) has no voice: it loops 20 seconds without the desk,
  so the desk rules cannot apply there.
