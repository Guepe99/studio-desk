# Voice-over

The replay can speak its stories in English. The clips are made beforehand with Azure Speech
(F0 free tier) from the verified story texts, committed in `replays/<match>/`, and played by the
broadcast page when a story goes on air for the visitor. No speech is generated at view time.

## Voices

Azure has no British English voice with a sports commentary style: the only voice whose style
list has `sports-commentary` and `sports-commentary-excited` is `zh-CN-YunjianNeural` (checked
on 19 Oct 2026 with the `voices/list` endpoint of our Sweden Central resource). So the choice
follows the way a football broadcast splits the work between two voices: a lead commentator who
calls the moments, and a summariser or analyst who talks when play is not live and sums up
([colour commentator, Wikipedia](https://en.wikipedia.org/wiki/Color_commentator); the RNIB
guide asks that analysis comes at a time that does not disrupt the main commentary,
[RNIB](https://www.rnib.org.uk/documents/1947/Best_practice_for_making_sports_commentaries_accessible_for_viewers_with_visio_xuVYOS9.pdf)).

| Role | Voice | Why | Used for |
|---|---|---|---|
| Lead commentator | `en-GB-RyanNeural` | male, tagged News, personality Bright and Engaging; has the `cheerful` style | every story except recaps |
| Summariser | `en-GB-SoniaNeural` | female, tagged Narration and News, personality Gentle and Soft | half-time and full-time recaps |

Voice tags and styles: the `voices/list` response of the resource, and the
[language support table](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts).

Prosody, sparingly ([SSML voice and sound](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice)):

- goals and comebacks: `mstts:express-as style="cheerful" styledegree="1.4"` (range 0.01 to 2,
  default 1) and `prosody rate="+6%" pitch="+4%"`;
- recaps: `prosody rate="-4%"`, no style;
- everything else: the plain voice.

The HD voices (`DragonHDLatestNeural`) are left out: the F0 tier is enough for 14 standard clips
a match, and the clips are small.

## What is read

`python -m studiodesk.voice <match> [--lang en] [--src DIR] [--out DIR] [--dry-run]`

- Source: `replays/<match>/stories.json` when the AI pack is there, else
  `web/data/<match>/stories.json`, or `--src`.
- Eligible stories: verifier `pass`, `rewritten` or `template`. Template lines are voiced too:
  code builds them from the fact ledger, so they are verified like the rest. Default status
  `auto_approved` or `needs_review` (the page decides per visitor whether a story is on air),
  safety not `flagged`.
- The text is the verified `texts.en`, with pronunciations only: `2-1` is read "two-one",
  `0` in a score "nil", `6.1/10` "6.1 out of 10", `73'` "minute 73", `km/h` and `m` in full.
  No word is added or removed.
- One request every 3.1 s (F0: 20 requests a minute); a 429 waits for `Retry-After`.
- Output: `replays/<match>/voice/<story_id>.en.mp3` (24 kHz mono, 48 kbps) and
  `replays/<match>/voice.json`, one row per clip:
  `{story_id, lang, file, duration_s, text_sha1, voice}`, `file` relative to the match folder.
- A rerun skips a story whose `text_sha1` and voice are unchanged, and deletes the clips of stories
  that left the replay. When the AI pack for a match is regenerated, run the script again: only
  the changed texts are sent to Azure.
- Key: `key1` of `studiodesk-speech`, read at run time from the Azure CLI (or `SPEECH_KEY`), never
  written to disk. Entra ID tokens need a custom subdomain, which this F0 resource does not have.

Other languages: `--lang` is wired through, but only `en` has voices for now; `it` and `es`
come with tappa 4.

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
- A story speaks once, when its first cue appears on screen (the OGraf host's `live` set), at 1x,
  in a language with a clip. Held, rejected and AI-off stories never reach the screen, so they
  never speak; the module also asks `desk.onAir()` every frame and stops a clip whose story leaves
  the air (reject, AI switch off).
- An edited story stays silent: the clip would say the old text. A clip whose `text_sha1` does not
  match the story text the page loaded is never played.
- One clip at a time. A story that comes up while another speaks waits; it is dropped if it would
  start more than 4 s of match time after its cue.
- Seeking stops the clip; a speed other than 1x, a language change or the mute button stop it; a
  pause pauses it. At full time the recap finishes even though the replay has stopped.
- The 3D sample page (`web/sample3d.html`) has no voice: it loops 20 seconds without the desk,
  so the desk rules cannot apply there.
