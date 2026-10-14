---
name: remove-fillers
description: Cut filler words (um, uh, er, ah, hmm) out of a project's edit using the transcript. Use when asked to remove ums, filler words, verbal tics or hesitations.
argument-hint: "[project-name] [extra fillers, e.g. \"you know, I mean\"]"
---

# Remove filler words

Cut filler words from the main track of `projects/<name>/timeline.json`. Follow
`.claude/rules/timeline-editing.md` for everything not covered here.

Arguments: `$ARGUMENTS`: an optional project name and optional extra phrases to treat
as fillers. If there's no project name and `projects/` holds more than one project,
ask which one.

Default fillers: **um, umm, uh, uhm, er, erm, ah, hmm, mm** (case-insensitive,
ignoring punctuation). Treat "like", "you know", "I mean", "so" and "basically" as
fillers only when the user lists them; they are usually real words.

## Requirements
This needs transcripts. If `npm run tl -- words` says a file has no transcript, stop
and ask the user to click **Transcribe** in the editor's Transcript tab.

Whisper often leaves fillers out of its transcript. If you find only a few, say so,
and suggest `/remove-pauses` for hesitations it didn't write down.

## Steps
1. `npm run tl -- snapshot`, `npm run tl -- summary` and `npm run tl -- duration`.
2. `npm run tl -- words` (timeline order, with source times). Find every filler.
3. For each filler, decide:
   - **Cut** the range from the end of the previous word to the start of the next word
     (in source time), keeping 0.05 s next to each neighbouring word. If either gap is
     longer than 0.6 s, keep 0.15 s of it instead, so the cut doesn't feel abrupt.
   - **Skip** it when it sits tightly inside a sentence (less than 0.1 s of gap on both
     sides): cutting there usually sounds unnatural. List what you skipped.
   - **Skip** it when its clip has a `note`, unless the user said to include those.
4. If the cuts would remove more than 20% of the runtime, show the plan first and ask.
5. Write the whole result in one write: split or trim the main-track clips in source
   time (first part keeps the id, new parts get new unique ids and copy the settings),
   times rounded to 3 decimals. The validation hook runs; fix anything it reports.
6. Report: how many fillers were cut and where (timeline timecodes), what was skipped
   and why, old → new duration, and a reminder to listen to the cuts in the preview.
