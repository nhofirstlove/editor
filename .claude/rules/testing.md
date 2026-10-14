---
paths:
  - "tests/**"
  - "**/*.test.ts"
  - "vitest.config.ts"
---

# Tests

- `npm test` runs everything (about 15–20 s); `npm run typecheck` checks both the Node
  side and the browser app (about 2 s). Run both before committing.
- Tests make their own media with ffmpeg in a temporary folder (`tests/helpers/test-media.ts`).
  Never point a test at `projects/`; use `PROJECTS_DIR` or `buildServer({ projectsDir })`
  with a temp folder.
- Tests that need ffmpeg skip themselves when it isn't installed (`hasFfmpeg`). The real
  transcription test needs faster-whisper and its `base` model already downloaded; the
  OpenTimelineIO test needs `OTIO_PYTHON`. Tests must never download anything.
- Use `buildServer({ …, watch: false })` unless the test is about the file watcher, so
  outside-change handling doesn't interfere.
- Snapshot files in `tests/__snapshots__/` are written by Vitest (`-u`), never by hand.
- Prefer checking behaviour end to end with measurable signals (durations from ffprobe,
  silencedetect, blackdetect) over checking implementation details.
- `tests/fixtures/speech.wav` is a Windows text-to-speech recording of: "Hello and
  welcome to the studio. Today we are talking about video editing. Um, this part should
  be removed. Thank you for watching, and see you next time."
