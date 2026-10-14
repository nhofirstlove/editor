# Build prompt — Text-driven video editor (v1)

**How to use this file**

- **Option A:** Paste everything under "Part 1" into Claude Code (or another coding agent) in an empty project folder.
- **Option B (recommended):** Save this file in the project folder as `SPEC.md`, then tell the agent: *"Build the app described in SPEC.md. Start with Milestone 1 and stop for my review after each milestone."*
- **Part 2** is the video-editing rules Claude follows when it edits `timeline.json`. In this starter set they live in `.claude/rules/timeline-editing.md` (they load only when Claude opens a timeline); `CLAUDE.md` holds the developer brief.

---

# Part 1 — Build prompt

## 1. Goal

Build a **local, browser-based video editor** for a small video studio.

The core idea: **the edit is stored as a plain-text JSON timeline file.**

- A human edits visually in the browser: watch, scrub, cut, trim, change speed, adjust volume.
- An AI agent (Claude) edits the same edit by reading and rewriting the JSON file directly.
- Both always see the same result, because the preview and the final export are both generated from that one file.

This is version 1. Keep the scope tight, make it reliable, and make it easy to extend.

## 2. Principles (follow these in every decision)

1. **`timeline.json` is the single source of truth.** The UI never holds edit state that isn't written to the file.
2. **Non-destructive.** Never modify, move, or re-encode the original media in place. Proxies and exports go in their own folders.
3. **Preview = export.** The preview player and the ffmpeg export must interpret the timeline identically: same cut points, same speeds, same order.
4. **Free and local.** Use only free, open-source tools. No paid APIs, no cloud services, no accounts. Do not use Remotion in v1.
5. **Safe with external edits.** The file can be changed by Claude at any time. Never crash on a bad edit, never silently overwrite an external change, always allow undo.
6. **Simple over clever.** Prefer plain, readable code over abstractions. No features beyond this spec without asking.

## 3. Tech stack

| Layer | Choice |
|---|---|
| Frontend | React + TypeScript + Vite |
| Waveform | wavesurfer.js (v7) or a custom canvas renderer using precomputed peaks |
| Backend | Node.js + TypeScript, Fastify (or Express), runs locally |
| Real-time sync | WebSocket or Server-Sent Events from server to browser |
| File watching | chokidar |
| Validation | zod, plus an exported JSON Schema file |
| Media processing | ffmpeg and ffprobe (system install; check on startup and show a clear error if missing) |
| Transcription (Milestone 5) | faster-whisper (Python), called from a small script |
| Timeline interchange (Milestone 6) | OpenTimelineIO (`.otio`) and/or FCPXML |
| Tests | Vitest (unit), plus one end-to-end script using ffmpeg-generated test media |

Ask before adding any dependency not listed here.

## 4. Project structure

```
/app                  React frontend
/server               Node backend (API, file watcher, ffmpeg jobs)
/cli                  Command-line helpers (see section 8)
/schema
  timeline.schema.json
/projects
  /<project-name>
    /media            original source files (read-only to the app)
    /proxies          low-res editing copies
    /peaks            precomputed waveform data
    /exports          rendered videos + the ffmpeg command used
    /history          timestamped timeline snapshots
    timeline.json
    transcript.json   (Milestone 5)
CLAUDE.md             developer brief for Claude
.claude/rules/timeline-editing.md   instructions for the AI editor (Part 2 of this file)
README.md
```

## 5. Timeline format (v1)

All times are in **seconds** (floating point, rounded to 3 decimals).

- **Source times** (`in`, `out`) refer to positions in the original media file.
- **Timeline times** are derived and never stored for main-track clips. Main-track clips play back-to-back in array order with no gaps.

```json
{
  "version": 1,
  "project": "client-interview-oct",
  "fps": 25,
  "resolution": { "width": 1920, "height": 1080 },
  "sources": [
    { "id": "src1", "path": "media/interview_take2.mp4", "duration": 742.36, "fps": 25 },
    { "id": "src2", "path": "media/music_bed.mp3", "duration": 95.0 }
  ],
  "tracks": {
    "main": [
      { "id": "c1", "sourceId": "src1", "in": 0.0,  "out": 12.4, "speed": 1.0,  "volume": 1.0, "muted": false, "label": "Intro" },
      { "id": "c2", "sourceId": "src1", "in": 15.8, "out": 42.1, "speed": 1.25, "volume": 1.0, "muted": false },
      { "id": "c3", "sourceId": "src1", "in": 50.0, "out": 63.5, "speed": 1.0,  "volume": 0.8, "muted": false, "note": "Keep this answer" }
    ],
    "music": [
      { "id": "m1", "sourceId": "src2", "start": 0.0, "in": 0.0, "out": 30.0, "volume": 0.3, "fadeIn": 1.0, "fadeOut": 2.0 }
    ]
  }
}
```

**Field rules**

- `id`: unique, stable string. Existing clips keep their id when edited. New clips get new ids.
- `in < out`, both within `0 … source.duration`.
- `speed`: 0.25 – 4.0. Clip timeline duration = `(out - in) / speed`.
- `volume`: 0.0 – 2.0 (1.0 = original).
- `label`, `note`: optional, free text for humans and Claude.
- `music` track clips (Milestone 6) have an explicit `start` in timeline seconds.

**Validation behaviour**

- Validate every load and every save with zod.
- If the file on disk is invalid (bad JSON or rule violation): keep showing the last valid state, show a clear error banner with the exact problem and location, and do not overwrite the file until the user or Claude fixes it.

## 6. Features (v1)

### 6.1 Project and media import
- Create or open a project. Import a video by file picker or drag-and-drop. Always copy it into `/media`; v1 does not reference files in place, so every original sits under the same read-only protection (and the same `.gitignore` rules). If the disk is too small for the copy, say so clearly instead of falling back to referencing the file.
- Read metadata with ffprobe: duration, fps, resolution, audio channels.
- Generate a **proxy** in the background with a progress indicator: 720p H.264 with a **short keyframe interval** (for example, a keyframe every 5–10 frames) so browser seeking is close to frame-accurate.
- Precompute **waveform peaks** to `/peaks` so long files draw instantly.

### 6.2 Player
- Plays the **edited sequence**, not the raw file. Map timeline time to (clip, source time) and jump between clips at cut points.
- Use **two video elements, double-buffered**. Pre-seek the next clip in the hidden element and swap at the cut, so cut points play with minimal stutter.
- Per-clip speed via `playbackRate`, with pitch preserved (`preservesPitch = true`).
- Per-clip volume and mute applied during playback.
- Controls: play/pause (Space), J/K/L shuttle, ←/→ step one frame, Shift+←/→ step one second, Home/End.
- Timecode display `HH:MM:SS:FF` for both timeline time and the current source time.

### 6.3 Timeline UI
- Time ruler with zoom (Ctrl/Cmd + scroll, plus zoom buttons) and horizontal scroll.
- Draggable playhead. Clicking the ruler moves the playhead.
- Main-track clips drawn as blocks whose width equals timeline duration, with the waveform drawn inside each block.
- Visual badges on clips: speed (e.g. `1.25×`), muted, has note.
- Selected clip is highlighted. An inspector panel shows its `in`, `out`, speed, volume, label, and note, all editable.
- Music lane below the main track (display in Milestone 2, editing in Milestone 6).

### 6.4 Editing operations
| Operation | Shortcut / control | Effect on timeline.json |
|---|---|---|
| Split at playhead | S | One clip becomes two (first keeps id, second gets new id) |
| Delete clip (ripple) | Delete / Backspace | Clip removed, following clips close the gap |
| Trim | Drag clip edges | `in` / `out` change |
| Set speed | Inspector dropdown: 0.5, 0.75, 1, 1.25, 1.5, 2, custom | `speed` changes |
| Volume / mute | Inspector slider, M to mute | `volume` / `muted` change |
| Reorder | Drag clip | Array order changes |
| Mark range and cut | I / O to mark, then Delete | Range removed across clips |
| Undo / redo | Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z | Restore previous file state |

Undo/redo history must include changes made externally by Claude.

### 6.5 Two-way sync with Claude
- **UI → file:** write `timeline.json` after every change, debounced about 300 ms. Use an atomic write (write a temp file, then rename).
- **File → UI:** the server watches `timeline.json`. On an external change, it validates the file, pushes it to the browser, and the UI reloads the timeline.
- On an external change, show a toast: *"Timeline updated externally"*, with a short **change summary** (clips added, removed, trimmed, speed changed, with timecodes) and an **Undo** button.
- Save a snapshot to `/history` before applying every external change, and also every 5 minutes while editing.
- Ignore the watcher event caused by the app's own writes, so changes don't loop.

### 6.6 Export
- The server builds an ffmpeg command from `timeline.json`, rendering from the **original media**, never the proxies:
  - per clip: `trim` / `atrim`, `setpts=PTS-STARTPTS`, then speed via `setpts=PTS/<speed>` and `atempo`. Chain `atempo` filters for speeds outside 0.5–2.0, for compatibility with older ffmpeg versions.
  - per-clip `volume`; muted clips get silent audio of the correct length, so audio and video stay in sync.
  - `concat` all clips in order.
  - (Milestone 6) mix the music track with `adelay`, `afade`, and `amix`.
- Presets: **Final** (source resolution, H.264, high quality, AAC audio) and **Quick preview** (720p, fast encode).
- Show a progress bar using `ffmpeg -progress`.
- Save the exact ffmpeg command next to each export in `/exports` for transparency and debugging.

### 6.7 Transcript editing (Milestone 5)
- Transcribe the source with faster-whisper, using **word-level timestamps**, into `transcript.json`.
- Transcript panel synced to playback: the current word is highlighted, and clicking a word seeks to it.
- Selecting words and pressing Delete cuts that range from the timeline. Removed words stay visible, struck through, so cuts are reviewable.

### 6.8 Hand-off to a professional editor (Milestone 6)
- Export the timeline as `.otio` (OpenTimelineIO) and/or FCPXML so it can be opened in DaVinci Resolve for colour, mixing, and finishing.

## 7. Non-goals for v1

Colour grading, visual effects, video transitions (hard cuts only), titles and overlays, multi-camera editing, multiple video tracks, cloud hosting, user accounts, and real-time collaboration. Don't build these. Keep the code structured so overlays and extra tracks can be added later.

## 8. CLI helpers for the AI editor

Claude edits more accurately when it can query the media instead of guessing. Provide these commands, all reading from the current project folder:

| Command | Output |
|---|---|
| `npm run tl -- validate` | OK, or a list of exact errors |
| `npm run tl -- summary` | Readable table: clip id, label, source in/out, timeline start/end, speed, volume |
| `npm run tl -- silences --min 0.6 --db -35` | JSON list of silent ranges in source time (ffmpeg `silencedetect`) |
| `npm run tl -- words --from 30 --to 60` | Transcript words with timestamps in a range (Milestone 5) |
| `npm run tl -- duration` | Total timeline duration |
| `npm run tl -- snapshot` | Save a copy to `/history` |
| `npm run tl -- preview` | Quick 720p render of the current timeline to `/exports` |

## 9. Acceptance criteria

- A 10-minute 1080p file imports, a proxy is generated, and playback is smooth.
- Split, delete, trim, and speed changes appear in the preview immediately.
- Exported video duration matches the timeline duration within one frame per clip, with audio and video in sync throughout.
- Editing `timeline.json` in a text editor updates the open UI within about 1 second, with a correct change summary.
- An invalid `timeline.json` never crashes the app. It shows a clear error and does not overwrite the file.
- Undo/redo works across both UI edits and external edits.
- All CLI helpers work and return clear output.

## 10. Tests

- Unit tests: timeline-to-source time mapping (including speed changes), schema validation, edit operations (split, ripple delete, trim, reorder), and the ffmpeg command builder (snapshot tests).
- End-to-end script: generate test media with ffmpeg (`testsrc` video plus a `sine` tone with silent gaps), apply a known timeline, export, then check the output duration with ffprobe and check that `silences` finds the gaps.

## 11. Milestones (work in this order, stop for review after each)

1. **Foundation:** project structure, schema and validation, media import, ffprobe metadata, proxy and peaks generation, a basic player for the raw source.
2. **Editing:** timeline UI, edited-sequence playback (double-buffered), split, delete, trim, speed, volume, reorder, undo/redo.
3. **Claude sync:** file watcher, external-change handling with change summary, snapshots, CLI helpers (`tl validate` must accept an optional file path, which the validation hook uses).
4. **Export:** ffmpeg command builder, presets, progress, saved command.
5. **Transcript:** faster-whisper transcription, transcript panel, word-based cutting.
6. **Music and hand-off:** music track editing and mixing, OTIO/FCPXML export.

After each milestone: run the tests, update the README, commit, and tell me exactly how to run and try the new features.

## 12. General working instructions

- The app must start with `npm install && npm run dev`, and the README must explain installing ffmpeg on macOS and Windows.
- Write clear error messages a non-developer can act on.
- When a requirement is ambiguous, choose the simplest option that meets the principles in section 2, note the decision in the README, and keep going.
- Don't add features outside this spec without asking.

---

# Part 2 — Video-editing rules (the AI editor's standing instructions)

These now live in `.claude/rules/timeline-editing.md`, which loads automatically when Claude opens a `timeline.json`. The copy below is for reference; edit the rule file, not this section.

```markdown
# Editing videos in this project

You are the assistant editor for a small video studio. You edit videos by changing
`projects/<name>/timeline.json`. A human reviews every change in the visual editor
and can undo it, so make clear, deliberate edits and always explain what you changed.

## Rules
- Only edit `timeline.json`. Never modify, move, delete, or re-encode files in `media/`.
- Read `schema/timeline.schema.json` before your first edit.
- Run `npm run tl -- snapshot` before making changes.
- Keep existing clip ids unchanged. Give every new clip a new unique id (e.g. "c17").
- Times are in seconds, rounded to 3 decimals. `in` and `out` are source times.
- Speed must stay between 0.25 and 4.0. Volume must stay between 0.0 and 2.0.
- Run `npm run tl -- validate` after every edit, and fix any errors before finishing.
- Don't guess where things are in the video. Use the helpers:
  - `npm run tl -- summary` to see the current edit
  - `npm run tl -- silences` to find pauses
  - `npm run tl -- words --from X --to Y` to find spoken words (when a transcript exists)
- Respect any clip `note` written by a human (e.g. "Keep this answer"). Don't cut or
  change those clips unless explicitly asked.
- If a request is ambiguous and the edit would be large (for example, removing more
  than 20% of the runtime), describe your plan and ask before applying it.

## Common requests and how to handle them
- "Remove pauses / tighten it": find silences longer than the requested length
  (default 0.6 s), split clips around them, and leave about 0.15 s of breathing room
  on each side so cuts don't feel abrupt.
- "Remove ums and filler words": use the transcript to find filler words and cut each
  word's range plus a small margin. Skip any that sit mid-sentence where a cut would sound unnatural.
- "Speed up the intro / this section": change `speed` only on the clips covering that
  range, splitting clips at the range boundaries if needed. Prefer 1.1–1.5× for speech.
- "Make it X minutes long": propose which sections to cut and why, then apply them after approval.
- "Label the sections": add short `label` values without changing any timing.

## After every edit, report back with
1. A short summary of what changed, with timeline timecodes (e.g. "Removed 7 pauses
   between 00:01:10 and 00:03:45").
2. The old and new total duration.
3. Anything you weren't sure about, for the human to check in the preview.
```
