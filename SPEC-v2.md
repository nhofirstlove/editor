# Editor v2 — specification

Status: **approved 2026-10-14** (decisions in section 9). v1 (`SPEC.md`, milestones 1–6) is complete.
Everything in `SPEC.md` still applies unless this file says otherwise, including the
principles in section 2 and the golden rules in `CLAUDE.md`.

## 1. Goal

Make the editor a dependable **tool inside an automated video pipeline**
(research → script → voiceover → images → shots → edit) while keeping it a tool for
people. The pipeline lives in its own project. It hands work to the editor by writing a
project folder (`media/` + `timeline.json`); a person reviews and adjusts it in the
browser, and the editor exports it.

The editor gains three things and nothing generative:

1. **Headless use:** every step a pipeline needs works from the command line, without
   the browser or the dev server.
2. **A voiceover track:** narration as its own audio lane, with music ducked under it.
3. **Still images as clips**, with an optional slow zoom.

## 2. Timeline format v2

`version` becomes `2`. Version 2 is a superset of version 1: every v1 file is a valid
v2 file apart from the number. The editor and CLI read both, and the first time they
save a v1 file they write it as `version: 2` (taking a `history/` snapshot first, as for
any change). The zod schema stays the single definition; `npm run schema` regenerates
`timeline.schema.json`.

```json
{
  "version": 2,
  "fps": 30,
  "resolution": { "width": 1080, "height": 1920 },
  "sources": [
    { "id": "src1", "path": "media/shot_01.mp4", "duration": 5.0, "fps": 30, "width": 1080, "height": 1920, "audioChannels": 0 },
    { "id": "img1", "kind": "image", "path": "media/still_02.png", "width": 2048, "height": 2048 },
    { "id": "vo",   "path": "media/voiceover.wav", "duration": 42.6, "audioChannels": 1 }
  ],
  "tracks": {
    "main": [
      { "id": "c1", "sourceId": "src1", "in": 0, "out": 5.0 },
      { "id": "c2", "sourceId": "img1", "in": 0, "out": 4.2, "fit": "cover", "zoom": { "from": 1.0, "to": 1.15 } }
    ],
    "voice": [
      { "id": "v1", "sourceId": "vo", "start": 0.3, "in": 0, "out": 42.6, "volume": 1.0 }
    ],
    "music": [],
    "mix": { "duckMusicUnderVoice": -12 }
  }
}
```

**New and changed fields**

| Field | Rule |
|---|---|
| `sources[].kind` | `"media"` (default, audio and/or video) or `"image"`. Image sources have `width`/`height` and no `duration`, `fps` or `audioChannels`. |
| main clip on an image source | `in` is 0; `out` is how long the image shows (0.04–3600 s). `speed` must be 1 and `muted`/`volume` don't apply (image clips are silent). |
| `main[].fit` | `"contain"` (default: whole picture, black bars) or `"cover"` (fill the frame, cropping the edges). Allowed on video clips too. |
| `main[].zoom` | Image clips only: `{ "from": 1.0, "to": 1.15 }`, scale factors 1.0–3.0, linear over the clip, centred. Optional `"focus": { "x": 0.5, "y": 0.5 }` (0–1) moves the centre of the zoom. |
| `tracks.voice` | Like `tracks.music`: each clip has an explicit `start` (timeline seconds), `in`, `out`, `volume` (default 1.0), optional `fadeIn`/`fadeOut`, `label`, `note`. Clips on the voice track must not overlap. |
| `tracks.mix.duckMusicUnderVoice` | Decibels (−30 to 0; default 0 = off). While any voice clip plays, music is lowered by this much, ramping over 0.25 s each side. |

Ducking follows the **voice clips' positions, not the sound**, so the player and the
export compute exactly the same gain (golden rule 3). It lives in `schema/sequence.ts`
next to `musicGainAt`.

Like music, voice clips keep their place when main-track clips are cut, trimmed or
reordered. Keeping picture and narration aligned is the assembly step's job (section 6).

## 3. Headless use (command line)

All commands work with no server running, write `timeline.json` atomically, and
validate before writing. A running editor picks up their changes through the file
watcher, with the usual change summary and Undo. Each command accepts `--json` for
machine-readable output, and exits 0 on success and 1 on any error (message on stderr).

| Command | Does |
|---|---|
| `tl new <name>` | Creates `projects/<name>/` with an empty v2 timeline. Fails if it exists. |
| `tl import <files…> [--to main\|voice\|music\|none] [--at <seconds>]` | Copies files into `media/`, reads them with ffprobe, adds sources, and adds clips: video → end of main, image → end of main for 3 s, audio → music by default (or `--to voice`), placed at `--at` (default 0). `--to none` adds sources only. Prints the new source and clip ids. Same disk-space check and file naming as the browser import. |
| `tl set --file <timeline.json>` | Replaces the timeline with a file the pipeline wrote, after validating it, with a snapshot first. The pipeline's main way to deliver an assembled edit. |
| `tl transcribe [--source <id>]` | Transcribes sources (default: all voice-track sources not yet transcribed) into `transcript.json`, showing progress. |
| `tl export --final\|--preview [--out <file>]` | Renders like the editor's Export buttons and checks the length. `tl preview` stays as a short form of `tl export --preview`. |
| `tl handoff` | Writes the `.otio` file for DaVinci Resolve. |

Proxies and waveforms are still made by the server when the project is opened. The CLI
doesn't need them.

`tl words` also lists voice-track words (with `"track": "voice"` and timeline times), so
an assembly step can cut shots to sentence boundaries.

## 4. Editor (browser)

- **Voice lane** between the main track and the music lane: drag to move, drag edges
  to trim, select to edit volume, fades, label and note in the Clip tab. Delete removes
  a voice clip. Overlapping a voice clip is refused, with a message.
- **Ducking:** a project setting in the Clip tab when no clip is selected ("Lower music
  under voice: off / −6 / −12 / −18 dB"). The music waveform shows the lowered sections.
- **Image clips** on the main track: a thumbnail strip instead of a waveform, a
  "still" badge, and Fit / Zoom from / Zoom to fields in the Clip tab. Trimming changes
  how long the image shows.
- **Player:** an image layer alongside the two video elements, with the zoom animated
  from the shared function; the voice track plays like music.
- **Import:** images and audio can be dropped like video. Audio asks "Voiceover or
  music?" (default music).
- **Transcript tab** shows voice-track sources too; deleting words there cuts the voice
  clip (not the main track).

## 5. Export and hand-off

- Image clips: `-loop 1 -t <duration> -i image`, scaled and cropped per frame from the
  shared zoom function (not `zoompan`, which jitters), then `fps` and `format` like
  video clips; silence of the exact length for audio.
- Voice clips: mixed like music (`atrim`, `afade`, `volume`, `adelay`). Ducking:
  `volume` with a time expression on the music branch, built from the voice clip
  intervals, before `amix … normalize=0`.
- `.otio`: image clips become clips referencing the image with their duration (zoom in
  metadata); the voice track becomes an audio track named "Voiceover", placed above
  "Music".

## 6. The pipeline contract (for the separate pipeline project)

- **Deliver:** `tl new` → `tl import` (assets, `--to none`) → write a v2 timeline →
  `tl set --file` → `tl export --preview`. A person opens the project to review.
- **Write timelines against `schema/timeline.schema.json`**, and run `tl validate --json`
  before `tl set`. Clip `note` fields are the way to tell the reviewer something ("shot
  regenerated twice; check hands").
- **Never write to `media/` after import**; regenerate an asset by importing it as a new
  file and pointing the clip at the new source.

## 7. Non-goals for v2

Anything generative inside the editor (it never calls TTS, image or video models),
captions and titles (candidate for v3; the transcript data is ready), transitions,
multiple video tracks, linking voice to main-track clips, cloud services or accounts.
No new dependencies are expected; ffmpeg and the existing stack cover all of the above.

## 8. Milestones

7. **Headless:** format v2 (version upgrade only), `tl new`, `tl import`, `tl set`,
   `tl transcribe`, `tl export`, `tl handoff`, `--json`. Test: a script builds a project
   from generated media with no server running, exports it, and checks the length.
8. **Voiceover track:** schema, lane, player, ducking, export, `.otio`, `tl words` for
   voice. Test: the end-to-end check measures that music is exactly the ducked amount
   quieter while a voice clip plays, in the same places in the player's gain function
   and in the export.
9. **Still images:** image sources, image clips, fit, zoom, player layer, export,
   `.otio`. Test: export a known zoom and compare frames at the start, middle and end
   with the shared zoom function (within one pixel of scale).

After each milestone: tests, README, commit, and stop for review, as in v1.

## 9. Decisions

1. **Ducking is off by default** (`duckMusicUnderVoice` 0). It's turned on per project.
2. **Images go on the main track only.** Overlays stay out of scope.
3. **`tl set` behaves like any outside change:** a snapshot is saved, an open editor
   shows the change with Undo, and an editor never overwrites it.
4. **Zoom is centred, with an optional focus point.** No panning in v2.

## 10. Notes from Milestone 7

- `tl import --to voice` waits for Milestone 8, and still images for Milestone 9; both
  say so clearly instead of failing.
- `tl set` checks that every source's file is already in `media/` before changing
  anything, so a pipeline can't deliver a timeline that points at missing footage.
- The command line and the server share one importer (`server/importer.ts`), so files
  are named, checked and placed the same way however they arrive.

## 11. Notes from Milestone 8

- The ramp is linear in decibels and sits outside the voice clip: music starts going
  down 0.25 s before a voice clip and is back up 0.25 s after it. Where two voice clips
  are closer than 0.5 s, the deeper of the two ramps wins.
- The export splits ducked music into 5 ms blocks before the `volume` filter, because
  ffmpeg evaluates the time expression once per block.
- `tl import --to voice` places the clip after the last voice clip unless `--at` is
  given; an overlapping `--at` is refused.
- Deleting words in a voiceover's transcript closes the gap inside that clip only; other
  clips keep their places.
- `tl transcribe` with no `--source` transcribes voice-track sources when there is a
  voice track, and every source with sound otherwise (the Milestone 7 behaviour).

## 12. Notes from Milestone 9

- The export samples the zoom window with `perspective` (per frame, sub-pixel) instead of
  per-frame `scale` + `crop`: ffmpeg's `crop` keeps the first frame's input size, so a
  size-changing `scale` can't drive it. Final exports work at twice the output size.
- Image sources get a JPEG copy for the browser (proxy) and no waveform.
- Trimming an image clip keeps `zoom.from`/`zoom.to`; splitting and cutting divide the
  zoom so each part continues smoothly.
- Images never set the timeline's `resolution` or `fps`; the first video does.
- The Clip tab also edits the zoom's focus point and a video clip's fit.
