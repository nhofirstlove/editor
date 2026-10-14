---
name: remove-pauses
description: Tighten an edit by cutting silent pauses out of the main track of a project's timeline.json. Use when asked to remove pauses, cut dead air, tighten a cut, or make speech snappier.
argument-hint: "[project-name] [min-pause-seconds, default 0.6]"
---

# Remove pauses

Tighten `projects/<name>/timeline.json` by cutting silences out of the main track.
Follow `.claude/rules/timeline-editing.md` for everything not covered here.

Arguments: `$ARGUMENTS` — an optional project name and minimum pause length in seconds.
If there's no project name and `projects/` holds more than one project, ask which one.
Default minimum pause: 0.6 s. Default breathing room kept on each side of a cut: 0.15 s.

## Requirements
The `tl` helpers exist from Milestone 3. If `npm run tl -- silences` isn't available
yet, stop and say so. Don't estimate pauses by ear or from waveform guesses.

## Steps
1. Read `schema/timeline.schema.json` and the timeline.
2. `npm run tl -- snapshot`, then `npm run tl -- summary` and `npm run tl -- duration`.
3. `npm run tl -- silences --min <min> --db -35`. The ranges are in SOURCE time.
4. For each main-track clip, find the silences that overlap its `in`–`out` range:
   - Shrink each silence by 0.15 s on both ends. If nothing is left, skip it.
   - Silence inside the clip: split the clip around it. The first part keeps the id,
     the second part gets a new unique id and copies `sourceId`, `speed`, `volume`,
     `muted`, and `label`. Put `note` on the first part only.
   - Silence touching the clip's start or end: trim `in` or `out` instead of splitting.
   - Skip clips that have a `note`, unless the user said to include them.
5. If the cuts remove more than 20% of the runtime, show the plan (count, total time
   removed, the longest cuts with timecodes) and ask before writing.
6. Write the whole result in one write, times rounded to 3 decimals. The validation
   hook runs; fix anything it reports.
7. Report as the timeline rules describe: number of pauses removed and where (timeline
   timecodes), old → new duration, and any clips skipped because of a `note`.
