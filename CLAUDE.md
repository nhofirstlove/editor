# Text-driven video editor

A local, browser-based video editor for a small studio. The edit lives in a plain JSON
file (`projects/<name>/timeline.json`). Humans edit it visually in the browser; Claude
edits the same file directly. Preview and export are both generated from that file.

The full specification is in `SPEC.md` (v1) and `SPEC-v2.md` (v2). Read them before starting a milestone.

## Status
- v1 complete: Milestones 1–6 approved 2026-10-14. v2 spec approved 2026-10-14.
  Milestones 7–8 approved 2026-10-14. Current milestone: 9 (Still images), built and awaiting review. Update this line when a milestone is approved.
- Work one milestone at a time. After each: run tests, update README, commit, and stop
  for review with clear "how to try it" steps.

## Commands
- Install and run: `npm install && npm run dev` (editor at http://localhost:5173; the
  `editor` entry in `.claude/launch.json` opens it in the browser pane)
- Tests: `npm test` (end-to-end export test alone: `npm run e2e`) · Types: `npm run typecheck`
- Regenerate the JSON Schema after changing `schema/timeline.ts`: `npm run schema`
- Timeline helpers. With more than one project, add `--project <name>`:
  - `npm run tl -- validate [path]` — check a timeline file (accept an optional path)
  - `npm run tl -- summary` — readable list of clips with timeline times
  - `npm run tl -- silences --min 0.6 --db -35` — find pauses in the source audio
  - `npm run tl -- words --from 30 --to 60` — transcript words in a timeline range (`--source src1` for source time)
  - `npm run tl -- duration` — total timeline duration
  - `npm run tl -- snapshot` — save a copy to `history/`
  - `npm run tl -- preview` — quick 720p render to `exports/`
- Build and deliver without the editor (Milestone 7; add `--json` for machine output):
  - `npm run tl -- new <name>` — create a project
  - `npm run tl -- import <files…> [--to main|voice|music|none] [--at <s>]` — copy into `media/` and add (images: main track, 3 s)
  - `npm run tl -- set --file <timeline.json>` — replace the timeline with a checked file
  - `npm run tl -- transcribe [--source <id>]` — transcribe files that have sound
  - `npm run tl -- export --final|--preview [--out <file>]` — render and check the length
  - `npm run tl -- handoff` — `.otio` for DaVinci Resolve
- System requirements: ffmpeg and ffprobe 7+ on PATH. Transcription (optional): Python 3
  with `faster-whisper`; the model is chosen with `WHISPER_MODEL` (default `small`).

## Stack
- Frontend: React + TypeScript + Vite (`app/`)
- Backend: Node.js + TypeScript, Fastify (`server/`)
- CLI helpers: `cli/`
- Validation: zod, with JSON Schema exported to `schema/timeline.schema.json`
- Media: ffmpeg / ffprobe. Transcription: faster-whisper via `server/transcribe.py`.
- Hand-off to DaVinci Resolve: OpenTimelineIO JSON written by `server/handoff.ts`.
- Tests: Vitest, plus an end-to-end script using ffmpeg-generated test media.
- Ask before adding any dependency not listed in SPEC.md.

## Project layout
- `app/` browser editor · `server/` API, file watcher, ffmpeg jobs · `cli/` helpers
- `schema/` timeline format · `tests/` unit and end-to-end tests
- Key files:
  - `schema/timeline.ts` — the zod schema (source of `timeline.schema.json`)
  - `schema/sequence.ts` — clip timing shared by player, CLI, export and hand-off
  - `schema/transcript.ts` — transcript format and placing words on the timeline
  - `app/src/edits.ts` — every edit operation (pure functions, tested)
  - `server/importer.ts` — importing a file (shared by the browser upload and `tl import`)
  - `cli/` — `tl.ts` (commands list), `inspect.ts`, `pipeline.ts`, `common.ts`
  - `server/export.ts` — the ffmpeg export · `server/handoff.ts` — the .otio hand-off
- `projects/<name>/` one video job:
  - `media/` original footage — read-only, never modified
  - `proxies/`, `peaks/`, `exports/`, `history/` — generated, safe to regenerate
  - `timeline.json` — the edit · `transcript.json` — words with timestamps (generated)

## Golden rules
1. `timeline.json` is the single source of truth. No edit state lives only in the UI.
2. Never modify, move, delete, or re-encode anything in `projects/*/media/`.
   A hook enforces this.
3. Preview and export must interpret the timeline identically.
4. Free, local, open-source tools only. No paid APIs or cloud services.
5. An invalid timeline must never crash the app or be overwritten silently.
6. Simple, readable code over abstractions. No features beyond SPEC.md without asking.

## Conventions
- TypeScript strict mode. Named exports.
- Times are seconds (float, 3 decimals). `in`/`out` are source times; main-track
  timeline positions are derived from clip order, never stored.
- Atomic file writes for `timeline.json` (write temp file, then rename).
- Error messages must be understandable by a non-developer and say what to do next.
- Tests live in `tests/` or next to the source as `*.test.ts`.

## Editing videos
When asked to edit a video (cut pauses, speed up a section, tighten an edit), follow
`.claude/rules/timeline-editing.md`. It loads automatically when you open a timeline.
After any timeline edit, a hook validates the file; fix every error it reports.
- Skills: `/remove-pauses`, `/remove-fillers`, `/cut-phrase` (remove specific spoken
  words), `/rough-cut` (from a brief), `/export` (user-only).
- After an edit with more than a few cuts, run the `edit-reviewer` agent (read-only) and
  pass its findings on to the user before reporting.

## Hooks in this project
- Before edits and commands: changes to `projects/*/media/` are blocked; hand edits to
  `schema/timeline.schema.json` and `tests/__snapshots__/` are blocked (regenerate them).
- After edits: `timeline.json` is validated.
- At the end of a turn with TypeScript changes: `npm run typecheck` runs; fix what it reports.
