---
name: rough-cut
description: Build a first assembly of a project's timeline.json from a written brief (story, key points, target length). Use when asked for a rough cut, first assembly, selects, or "cut this down to the good parts".
argument-hint: "[project-name] [brief text or path to a brief file]"
---

# Rough cut from a brief

Build a first assembly on the main track of `projects/<name>/timeline.json` from a
brief. Follow `.claude/rules/timeline-editing.md` for everything not covered here.

Arguments: `$ARGUMENTS` — a project name and the brief, either as text or as a path to
a file. If either is missing, ask for it. A useful brief says who the video is for,
the story or key points in order, the target length, and anything that must stay in.

## Requirements
Choosing content needs to know what is said, so this works from the transcript
(`npm run tl -- words`, Milestone 5). If there's no transcript yet, stop and say so.
Don't pick segments by guessing.

## Steps
1. Read the brief, `schema/timeline.schema.json`, the timeline, and the transcript.
2. If the timeline already has clips, especially clips with a `note`, ask whether to
   replace the edit or build from it. Don't drop human notes silently.
3. Find candidate segments for each point in the brief. Start and end on sentence
   boundaries, using word timestamps with about 0.15 s of margin.
4. Show the plan before writing anything: for each segment, the brief point it
   covers, source in/out, the first and last few words, and its length. Give the total
   against the target length, and list brief points with no good match.
5. After the user approves (with or without changes), `npm run tl -- snapshot`, then
   write the main track in story order in one write. Give each clip a new unique id
   and a short `label` naming its brief point. Keep speed 1.0 and volume 1.0. Pacing
   is a later pass (`/remove-pauses`).
6. The validation hook runs; fix anything it reports. Then report: clip count, total
   duration against the target, sections by timeline timecode, and anything to check
   in the preview.
