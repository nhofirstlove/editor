---
paths:
  - "server/export.ts"
  - "server/export-routes.ts"
  - "server/handoff.ts"
  - "server/media.ts"
  - "schema/sequence.ts"
  - "tests/export*.ts"
  - "tests/e2e.test.ts"
  - "tests/handoff.test.ts"
---

# Working on export, proxies and the hand-off

- **One source of timing.** Where a clip sits and how timeline time maps to source time
  live in `schema/sequence.ts` (`layoutMain`, `locate`, `musicGainAt`, `duckGainAt`). The player,
  CLI, export and `.otio` hand-off all use it. Change timing there, never in one
  consumer only (golden rule 3: preview and export must agree).
- **Exports render from `media/`**, never from `proxies/`. ffmpeg runs with the project
  folder as its working directory, so paths in commands are relative (`media/…`,
  `exports/…`). Only read from `media/`; write to `exports/`, `proxies/` or `peaks/`.
- **Inputs:** clips that play forward through a file share one `-ss/-t` input; a jump
  back, a skip over `MAX_SHARED_GAP`, or a file change opens a new input. Don't go back
  to one shared input for everything: reordered clips then made ffmpeg buffer frames
  (5.8 GB measured for 30 reversed 1080p clips).
- **The filter graph goes in a file** read with `-/filter_complex` (ffmpeg 7+), because
  long edits exceed Windows' 32,767-character command line. Keep it that way.
- **Audio stays in sync:** muted clips and sources without audio get `anullsrc` of the
  clip's exact timeline length; every audio chain ends in the same `aformat`; speed uses
  chained `atempo` steps within 0.5–2.0. Voiceover and music are mixed with
  `amix … normalize=0` and `duration=first`. Ducking is a `volume` time expression
  (`duckExpression`) after `asetnsamples` 5 ms blocks; keep it matching `duckGainAt`
  (the end-to-end test measures both).
- **Still images:** each image clip is its own `-loop 1 -framerate fps -t len` input,
  fitted with `fitChain`, then zoomed with `perspective` (`zoomCorners`, matching
  `zoomWindow`; its `in` counts from 1). Don't switch to `zoompan` (jitters) or a
  per-frame `scale` + `crop` (crop keeps the first frame's size).
- **After changing any of this,** run `npm test`, and `npm run e2e` on its own for the
  end-to-end check (it proves cut points, speed and A/V sync with blackdetect and
  silencedetect). Only update `tests/__snapshots__/export.test.ts.snap` when the command
  is meant to change: run `npx vitest run tests/export.test.ts -u`, then read the diff.
- **Hand-off (`server/handoff.ts`):** whole frames, rounded from the running timeline
  position; music ends with the main track. With `OTIO_PYTHON` pointing at a Python that
  has `opentimelineio`, `tests/handoff.test.ts` also loads the file with OTIO itself.
