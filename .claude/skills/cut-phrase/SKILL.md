---
name: cut-phrase
description: Cut a specific spoken phrase out of a project's edit, found by its words in the transcript. Use when asked to remove, cut or delete particular words or a line someone says (e.g. "remove 'but he's talking'", "cut the bit where she says sorry").
argument-hint: "[project-name] \"phrase to cut\" [which one / speaker hint]"
---

# Cut a phrase

Remove a spoken phrase from `projects/<name>/timeline.json` by finding it in the
transcript. Follow `.claude/rules/timeline-editing.md` for everything not covered here.

Arguments: `$ARGUMENTS`: an optional project name, the phrase, and optionally a hint
about which occurrence (e.g. "the second one", "the female voice", "around 1:20").
If there's no project name and `projects/` holds more than one project, ask which one.

## Requirements
This needs a transcript of the file the phrase is in. If `npm run tl -- words` says a
file has no transcript, stop and ask the user to click **Transcribe** in the editor's
Transcript tab, then try again. Don't guess where words are from the waveform.

## Steps
1. `npm run tl -- snapshot` and `npm run tl -- summary` (add `--project <name>`).
2. Find the phrase: `npm run tl -- words` lists the words that play in the edit, in
   timeline seconds, with `clipId`, `sourceId` and `sourceStart`/`sourceEnd`. Match
   case-insensitively, ignoring punctuation, across consecutive words. Whisper can
   mishear a word, so also consider near matches and say when you used one.
3. If the phrase isn't in the edit, check whether it was already cut:
   `npm run tl -- words --source <id>` lists every word of a file with `"inEdit"`.
4. **More than one match:** list each with its timeline timecode and a few words
   before and after, then ask which one, unless the user's hint settles it.
   Transcripts don't know who is speaking. If the hint is about a voice or speaker,
   say that you can't tell voices apart from the transcript, show the candidates with
   their surrounding words (often the sentence makes it clear), and ask.
5. **Work out the cut, in the clip's source time:**
   - From the first word's `sourceStart` to the next word's `sourceStart`, so the
     pause after the phrase goes too and the speech keeps its rhythm (this matches the
     editor's own word Delete).
   - If the gap after the phrase is longer than 1 s, stop at the last word's
     `sourceEnd` + 0.25 s instead, and mention the pause that remains.
   - Whisper often starts the first word after a silence about 0.2 s early. That only
     moves the cut into the silence before it, which is fine.
6. **Edit the main track** in one write: for each clip of that source overlapping the
   range, trim its `in`/`out` if the range touches an end, or split it around the range
   (the first part keeps the id, the second gets a new unique id and copies the clip's
   settings). Don't change a clip with a `note` unless the user said to. Times rounded
   to 3 decimals.
7. The validation hook runs; fix anything it reports. Then report: what was cut, with
   its timeline timecode and the words, old → new duration (`npm run tl -- duration`),
   and anything you were unsure about (which occurrence, near matches, a jump cut in
   the picture worth checking).
