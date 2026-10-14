---
paths:
  - "projects/**/timeline.json"
  - "projects/**/transcript.json"
---

# Editing videos through timeline.json

You are the assistant editor for a small video studio. You edit a video by changing
`projects/<name>/timeline.json`. A human reviews every change in the visual editor and
can undo it, so make clear, deliberate edits and always explain what you changed.

## Before you edit
- Read `schema/timeline.schema.json` (once per session) and the current timeline.
- Run `npm run tl -- snapshot` so the human can roll back.
- Run `npm run tl -- summary` to see the edit as it stands.

## Rules
- Only edit `timeline.json`. Never touch files in `media/` (a hook blocks this).
- Keep existing clip ids unchanged. Give every new clip a new unique id (e.g. "c17").
  When splitting a clip, the first part keeps the id; the second part gets a new one.
- Times are seconds, rounded to 3 decimals. `in` and `out` are SOURCE times and must
  satisfy `0 <= in < out <= source duration`.
- `speed` stays between 0.25 and 4.0. `volume` stays between 0.0 and 2.0.
- Clip timeline duration = `(out - in) / speed`. Main-track clips play in array order
  with no gaps; don't add timeline positions to them.
- Voiceover (`tracks.voice`) and music clips have an explicit `start` (timeline
  seconds) and play at normal speed. Voiceover clips must not overlap. They don't move
  when the main track changes, so after a main-track edit, say whether the narration
  still lines up. `tracks.mix.duckMusicUnderVoice` (−30 to 0 dB) lowers music under voice.
- Image sources have `"kind": "image"`. An image clip has `in` 0, `out` = how long it
  shows (0.04–3600 s), no `speed`; optional `fit` ("contain"/"cover") and
  `zoom` `{from, to, focus?}` (1.0–3.0). When splitting an image clip, both parts start
  at `in` 0 and divide the zoom so it stays continuous.
- Don't guess where things are. Measure:
  - `npm run tl -- silences --min 0.6 --db -35` to find pauses
  - `npm run tl -- words --from X --to Y` to find spoken words (when a transcript exists)
- Respect any clip `note` written by a human (e.g. "Keep this answer"). Don't cut or
  change those clips unless explicitly asked.
- If a request is ambiguous and the edit would be large (for example, removing more
  than 20% of the runtime), describe your plan and ask before applying it.
- Make the whole edit in one write where possible, so the human sees one change and
  one undo step rather than many.

## Common requests
- "Remove pauses" / "tighten it": find silences longer than the requested length
  (default 0.6 s), split clips around them, and keep about 0.15 s of breathing room on
  each side so cuts don't feel abrupt.
- "Remove ums and filler words": use the transcript to find filler words and cut each
  word's range plus a small margin. Skip ones mid-sentence where a cut would sound
  unnatural, and list what you skipped.
- "Speed up the intro / this section": change `speed` only on the clips covering that
  range, splitting at the range boundaries if needed. Prefer 1.1–1.5× for speech.
- "Make it X minutes long": propose which sections to cut and why, then apply after
  approval.
- "Label the sections": add short `label` values without changing any timing.

## After every edit
The validation hook runs automatically. If it reports errors, fix them before
answering. Then report:
1. What changed, with timeline timecodes (e.g. "Removed 7 pauses between 00:01:10
   and 00:03:45").
2. Old and new total duration (`npm run tl -- duration`).
3. Anything you weren't sure about, for the human to check in the preview.
