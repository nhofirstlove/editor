# Text-driven video editor

A local, browser-based video editor for a small studio. The edit lives in a plain JSON
file, `projects/<name>/timeline.json`. People edit it in the browser; Claude edits the
same file directly. Everything runs on your own computer: no accounts, no cloud.

The full specification is in [SPEC.md](SPEC.md).

**Status: v1 complete (milestones 1–6); v2 complete: Milestones 7 (command line for pipelines), 8 (voiceover track) and 9 (still images), see `SPEC-v2.md`.** You can import
video, then cut, trim, split, reorder, change speed and volume, and play back the edited
result in the browser. Every change is saved to `timeline.json` straight away, and
undo/redo works. When Claude (or anything else) edits the file, the editor updates
within a second and shows what changed, with an Undo button. Claude has command-line
helpers to inspect the edit and find pauses. Speech can be transcribed on this
computer, and you can cut by selecting words in the transcript. Voiceover and music
each have their own track with volume and fades, and music can be turned down
automatically under the voiceover. Still images can go on the main track too, with an
optional slow zoom. The finished edit exports to an MP4 file (voiceover and music mixed
in), and to an OpenTimelineIO file for finishing in DaVinci Resolve.

## Requirements

- **Node.js 22.18 or newer** (Node 24 LTS recommended). Download it from https://nodejs.org.
  The server runs its TypeScript directly with Node, so there is no build step.
- **ffmpeg and ffprobe, version 7 or newer**, on your PATH (ffprobe comes with ffmpeg).
  Exporting needs version 7; everything else works with older versions too.
- **For transcripts (optional): Python 3.10 or newer with faster-whisper.** Everything
  else works without it.

### Installing ffmpeg

**macOS:** install [Homebrew](https://brew.sh), then run:

```bash
brew install ffmpeg
```

**Windows**, either:

- with winget (built into Windows 10 and 11), in PowerShell:
  ```powershell
  winget install --id Gyan.FFmpeg -e
  ```
- or by hand: download a "release full" build from https://www.gyan.dev/ffmpeg/builds/,
  unzip it to `C:\ffmpeg`, and add `C:\ffmpeg\bin` to your PATH (Start → "Edit the
  system environment variables" → Environment Variables → Path → Edit → New).

Close and reopen your terminal, then check that both commands work:

```bash
ffmpeg -version
```

```bash
ffprobe -version
```

If the editor can't find ffmpeg, it still opens but shows a red banner explaining what
to do. Restart the editor after installing ffmpeg.

### Installing transcription (optional)

1. Install Python 3 from https://www.python.org (on Windows, tick "Add python.exe to
   PATH" in the installer). On macOS, `brew install python` also works.
2. In a terminal, install faster-whisper:
   ```bash
   pip install faster-whisper
   ```
   (On macOS use `pip3` if `pip` isn't found.)
3. Restart the editor. If the Transcript panel says transcription isn't available,
   it explains what's missing.

The first transcription downloads the speech model once (about 500 MB for the default
`small` model) from Hugging Face; after that everything runs offline on this computer.
A graphics card is used if its CUDA libraries are installed; otherwise the processor
is used automatically (slower, but works everywhere).

## Running the editor

```bash
npm install && npm run dev
```

Then open http://localhost:5173. Stop it with Ctrl+C in the terminal.

`npm run dev` starts two things: the API server on `127.0.0.1:5174` (reachable only
from this computer) and the browser app on port 5173. The server restarts on its own
when its code changes.

## Getting started

1. Open http://localhost:5173 and create a project, for example `my-first-edit`. This
   creates `projects/my-first-edit/` with `media/`, `proxies/`, `peaks/`, `exports/`,
   `history/` and an empty `timeline.json`.
2. Drag a video file onto the page, or click **Import video…**. Several files at once
   work too.
   - The file is **copied** into `media/`, and a progress bar shows the copy. Your
     original stays where it was.
   - ffprobe reads its length, frame rate, resolution and audio channels. The file
     becomes a source in `timeline.json`, plus one clip on the timeline covering the
     whole file.
3. Watch the Media list. **Waveform** is ready within seconds. **Proxy** shows a
   percentage while a 720p editing copy is made in the background (roughly 3–6
   minutes for 10 minutes of 1080p footage, depending on your computer). You can
   import more files while you wait; they queue up. Playback starts working once the
   proxy is ready.

## Editing

The editor fills the window, so everything is in view without scrolling: the player
at the top left (it shrinks to fit, keeping the picture's shape), the timeline along
the bottom, and a side panel on the right with four tabs: **Transcript**, **Clip** (the
selected clip's settings), **Media** (imported files and import progress) and
**Export**. Clicking a clip on the timeline opens the Clip tab; importing opens the
Media tab. On small windows (under 1000 pixels wide or 560 tall) the parts stack and
the page scrolls instead.

| Do this | How |
|---|---|
| Play / pause | **Space**, or the ▶ button |
| Shuttle back / stop / forward | **J / K / L** (press J or L again for 2×, 4×, 8×) |
| Step one frame | **← / →** |
| Jump one second | **Shift + ← / →** |
| Go to start / end | **Home / End** |
| Move the playhead | Click or drag on the ruler, or drag the yellow handle |
| Select a clip | Click it. Its settings appear in the **Clip** panel |
| Split at the playhead | **S** |
| Delete the selected clip (later clips close the gap) | **Delete** or **Backspace** |
| Cut a range across clips | **I** at the start, **O** at the end, then **Delete** |
| Clear marks and selection | **Esc** |
| Trim | Drag a clip's left or right edge |
| Reorder | Drag a clip left or right; a blue line shows where it will land |
| Speed | Clip panel: 0.5×, 0.75×, 1×, 1.25×, 1.5×, 2×, or Custom (0.25–4) |
| Volume | Clip panel slider, 0–200% |
| Mute | **M** (selected clip, or the clip under the playhead), or the Clip panel |
| Label and note | Clip panel text boxes |
| Undo / redo | **Ctrl+Z / Ctrl+Shift+Z** (Cmd on a Mac; Ctrl+Y also redoes) |
| Zoom the timeline | **Ctrl + scroll** (Cmd on a Mac), or the − / + / Fit buttons |
| Scroll the timeline | Mouse wheel, or the scroll bar |

The player shows two timecodes: **TL** is the position in the edited timeline, and
**SRC** is the matching position in the original file (and which clip you're in).
Clips show badges for speed (`1.25×`), `muted`, and `note`. Hover over a clip for its
exact times.

**Saving:** every change is written to `timeline.json` about 0.3 seconds later. The
indicator next to Undo/Redo shows **Saved** or **Saving…**.

### Things to try

1. Press **S** at a few points, select a piece and press **Delete**. Play across the cut:
   it jumps straight to the next clip.
2. Select a clip and set its speed to 2×. Its block halves in width, and it plays twice
   as fast without the voice going high-pitched.
3. Mark a range with **I** and **O** that spans two clips, then press **Delete**.
4. Drag the edge of a clip to trim it, then drag a whole clip to a new place.
5. Press **Ctrl+Z** a few times, then **Ctrl+Shift+Z**.
6. Open `timeline.json` in a text editor while the editor is open. Change a clip's
   `"speed"` or `"label"` and save. Within a second the editor shows your change and a
   **Timeline updated externally** message; its **Undo** button takes it back.
7. Break the file (for example set an `"in"` larger than its `"out"`). A red banner
   names the problem and editing pauses. The editor won't touch the file until it's
   fixed.

## Working with Claude

Claude edits a video by changing `timeline.json` directly (see
`.claude/rules/timeline-editing.md`). Ask in plain words, or use a skill:

- `/remove-pauses`: cut silences longer than a set length.
- `/remove-fillers`: cut "um", "uh" and similar, using the transcript.
- `/cut-phrase "words to cut"`: remove a particular line; if it's said more than once,
  Claude asks which one.
- `/rough-cut`: build a first assembly from a written brief (needs a transcript).
- `/export`: render a preview.

After larger edits, Claude runs a read-only reviewer (the `edit-reviewer` agent) that
checks for cuts through words, changed clips that had a note, and very short clips,
and tells you what to look at. Keep the editor open while Claude works:

- **The editor updates within a second** of the file changing. A message in the corner
  says what changed (clips added, removed or trimmed, speed and volume changes, with
  timeline timecodes) and offers **Undo**. **Ctrl+Z** works too, at any time.
- **Nothing is lost.** Before taking in an outside change, the server saves the previous
  version to `history/` (`..._external.json`). While you edit in the browser it also
  saves a copy at most every 5 minutes (`..._auto.json`). To go back to one, copy it over
  `timeline.json`; the editor picks that up as an outside change, so it can be undone too.
- **If you and Claude change the file at the same moment**, the editor never overwrites
  Claude's version. It shows the file's version and tells you, and Undo brings your
  change back.
- **If Claude leaves the file invalid**, the editor keeps showing the last valid version
  with a red banner listing the problems, and pauses editing until the file is fixed. A
  hook also validates the file after every edit Claude makes, so this should be rare.

### Timeline helpers

Claude uses these to measure instead of guessing. You can run them too:

```bash
npm run tl -- summary
```

| Command | What it prints |
|---|---|
| `npm run tl -- validate [path]` | `OK`, or each problem with its location. Defaults to the project's `timeline.json` |
| `npm run tl -- summary` | A table of clips: id, label, source in/out, timeline start/end, speed, volume, notes |
| `npm run tl -- duration` | Total length, in seconds and as a timecode |
| `npm run tl -- silences --min 0.6 --db -35` | Pauses in the source audio, as JSON in source seconds. `--source src1` picks one source |
| `npm run tl -- snapshot` | Saves a copy of `timeline.json` to `history/` |
| `npm run tl -- words --from 30 --to 60` | Transcribed words as JSON, in timeline seconds, with each word's clip and source times. `--source src1` lists that file's words in source seconds instead, including words cut from the edit (`"inEdit": false`) |
| `npm run tl -- preview` | Renders a quick 720p preview to `exports/` and checks its length (same as `export --preview`) |
| `npm run tl -- help` | The list above |

**Which project?** With one project, the helpers use it. With several, add
`--project <name>` (or `-p <name>`), or run the command from inside the project folder.

### Building a project from the command line (for pipelines)

Everything needed to make and deliver an edit also works without the editor or its
server running, so an automated pipeline (or a script) can drive it. If the editor is
open on that project, it shows each change as an outside change, with Undo.

```bash
npm run tl -- new launch-video
```

| Command | What it does |
|---|---|
| `npm run tl -- new <name>` | Creates a project folder with an empty timeline |
| `npm run tl -- import <files…>` | Copies files into `media/` and adds them: video to the end of the main track, images to the end of the main track for 3 seconds, audio to the music track. `--to voice` puts audio on the voiceover track instead (after the last voiceover clip). `--to main`, `--to music` or `--to none` (source only, for the pipeline to place itself), and `--at <seconds>` for where music or voiceover starts |
| `npm run tl -- set --file <timeline.json>` | Replaces the timeline with a file the pipeline wrote, after checking it and checking that every file it uses is already in `media/`. The previous timeline is saved in `history/` |
| `npm run tl -- transcribe [--source src1]` | Transcribes the voiceover's files that have no transcript yet (or, with no voiceover, every file with sound), or the one named |
| `npm run tl -- export --final` / `--preview` | Renders the edit to `exports/` and checks its length. `--out <file>` also copies it somewhere |
| `npm run tl -- handoff` | Writes the `.otio` file for DaVinci Resolve |

Add `--json` to any command for output a program can read. On errors, the command
prints `{"ok": false, "error": "…"}`, explains the problem on the error output, and
exits with code 1. A typical pipeline delivery:

```
tl new <name> → tl import <assets…> --to none --json → write timeline.json yourself
→ tl validate <file> --json → tl set --file <file> → tl export --preview --json
```

Timelines are written in **format version 2**. Version 1 files still open and work;
the first time one is saved it's upgraded, and the version 1 copy is kept in
`history/` (`…_upgrade.json`).

## Transcript

The transcript is in the **Transcript** tab of the side panel.

1. Click **Transcribe** for a file in your edit. It runs in the background with a
   progress bar; on the processor, expect very roughly a third to a half of the
   video's length with the default model.
2. While the video plays, the word being spoken is highlighted and the transcript
   scrolls along. **Click a word** to jump to it.
3. To cut words, click the first one and **Shift+click** the last, then press
   **Delete** (or **Cut from the edit**). The words and the pause after them are cut
   from every clip that plays them. They stay in the transcript, **struck through**,
   so you can see what was cut; **Undo** brings them back.
4. **Transcribe again** replaces a file's transcript, for example with a bigger model.

The transcript is stored in the project's `transcript.json`, one word per line with
its start and end in source seconds. Claude reads it through
`npm run tl -- words` to find what is said where (for rough cuts and removing filler
words). The editor never changes `timeline.json` when transcribing.

## Music

Import an audio file (mp3, wav, m4a, aac, flac…) the same way as video: drag it onto the
page or use **Import video or audio…**, and choose **Music** when asked. It goes on the
**music track** at the bottom of the timeline, starting at the beginning, at 30% volume
so it sits under speech.

- **Move** a music clip by dragging it; **trim** it by dragging its left or right edge.
  Trimming the left edge keeps the rest of the music where it was.
- **Click** a music clip to see its settings in the **Clip** tab: start time,
  in/out in the music file, **volume** (0–200%), **fade in** and **fade out** (seconds),
  label and note. Fades are drawn as shaded corners on the clip.
- **Delete** removes the selected music clip. Nothing else moves.
- Music clips can overlap; they're mixed together.
- Music keeps its place on the timeline when you cut, trim or reorder the main track.
  It plays only while the main track does, and stops where the main track ends.

The player and the export use the same volume and fade curve (linear fades).

## Voiceover

Narration has its own lane, **Voiceover**, between the main track and the music. Import
an audio file and choose **Voiceover** when asked (or `npm run tl -- import narration.wav
--to voice`). It goes after any voiceover already there, at full volume.

- **Move**, **trim**, **select** and **delete** voiceover clips just like music clips;
  the Clip tab has the same settings (start, in/out, volume, fades, label, note).
- **Voiceover clips can't overlap.** Dragging one into another stops where they touch,
  with a message; typing a start time that would overlap is refused, with a message.
- Voiceover keeps its place when you cut, trim or reorder the main track (lining up
  pictures with the narration is up to you, or to the pipeline that assembled the edit).
- **Transcript:** voiceover files appear in the Transcript tab with a *voiceover* badge.
  Click a word to jump to it on the timeline. Deleting words cuts them out of the
  voiceover clip (not the main track), and the rest of that clip moves up to close the
  gap; other clips stay where they are.

### Lowering music under the voiceover (ducking)

With no clip selected, the **Clip** tab shows **Lower music under voice**: off, −6, −12
or −18 dB. While any voiceover clip plays, the music is turned down by that much, easing
down over the quarter of a second before the clip and back up over the quarter of a
second after it. The music waveform is drawn lower where it's turned down. It's off
until you choose a level (stored in `timeline.json` as
`"mix": { "duckMusicUnderVoice": -12 }`).

Ducking follows where the voiceover **clips** are, not how loud they are, so the player
and the export lower the music in exactly the same places.

## Still images

Import a PNG or JPEG (also WebP, BMP and TIFF) like a video: drop it on the page, use
**Import video, audio or images…**, or `npm run tl -- import still.png`. It goes at the
end of the main track and shows for 3 seconds. Images don't change the project's size or
frame rate; the first video does.

- On the timeline an image clip shows the picture as a strip, with a **still** badge.
  Move, split, cut and delete it like any clip. Dragging either edge changes **how long
  the image shows**.
- In the **Clip** tab: **Shows for** (seconds, 0.04–3600), **Fit** and **Zoom from /
  Zoom to**:
  - **Fit**: *Whole picture* (black bars when the shape differs from the frame) or
    *Fill the frame* (crops the edges). Video clips have the same setting.
  - **Zoom**: the picture scales steadily from the first value to the second over the
    clip, for example 1 → 1.15 for a slow push in (1 is no zoom; up to 3). **Zoom centre
    across / down** (0–1) moves the point that stays put; 0.5, 0.5 is the middle.
  - Splitting or cutting a zooming image keeps the zoom smooth: each part continues
    from where the other left off. Changing how long it shows stretches the zoom over
    the new length.
- Images have no sound, so speed, volume and mute don't apply. Voiceover and music keep
  playing over them.

In the file, an image source has `"kind": "image"` and its width and height, and an
image clip has `"in": 0` with `"out"` as how long it shows:

```json
{ "id": "c2", "sourceId": "img1", "in": 0, "out": 4.2, "fit": "cover", "zoom": { "from": 1.0, "to": 1.15 } }
```

The player and the export compute the zoom with the same function, so the preview
moves exactly like the exported video.

## Exporting

In the editor, the **Export** tab on the right has three buttons:

- **Final**: the timeline's full resolution, high-quality H.264 video and AAC audio.
- **Quick preview**: 720p (the shorter side of the picture is 720 pixels), fast to
  make and smaller. Good for sending a draft.
- **For DaVinci Resolve**: an OpenTimelineIO (`.otio`) file of the edit, made in an
  instant. See the next section.

A progress bar shows while it renders. Finished exports appear in the list with
**Play** (opens it in a new browser tab), the length, and the file size. Files are saved
in the project's `exports/` folder, named like `my-first-edit_final_2026-10-14_15-30-05.mp4`.

From the command line, `npm run tl -- export --final` or `npm run tl -- export --preview`
does the same (add `--project <name>` if you have several projects).

How it works, and what to expect:

- Exports always render from the **original files** in `media/`, never the 720p
  proxies, using exactly the same timing rules as the player.
- Muted clips, and clips from files without sound, get silence of exactly the right
  length, so sound and picture stay in step.
- Clips from files of different sizes are fitted into the frame with black bars, not
  stretched.
- Next to each export, `….ffmpeg.txt` holds the exact ffmpeg command that made it, and
  `….filtergraph.txt` the per-clip cutting and speed instructions it reads. Run the
  command from the project folder to make the same file again.
- The editor exports what's saved in `timeline.json`, so the buttons wait until your
  last change is saved, and are disabled while the file has errors.
- Exports run one at a time, after any proxies being prepared.
- Images are read from the original files. A zooming image takes longer than video to
  render in a **Final** export (about 3 seconds per second of 1080x1920 zoom), because
  it's worked out at twice the size to keep zoomed-in detail sharp; previews skip that.
- The voiceover and music tracks are mixed with the main track's sound, at each
  clip's volume and with its fades, and the music is lowered under the voiceover when
  that's turned on. The mix keeps every level as set (it doesn't turn the dialogue down
  to make room), and ends with the main track.

## Finishing in DaVinci Resolve

**For DaVinci Resolve** in the Export panel writes `exports/<project>_resolve_<time>.otio`
and lists it with a **Download** link.

1. In DaVinci Resolve (18.5 or newer), open a project and choose **File → Import →
   Timeline…**, then pick the `.otio` file.
2. Resolve finds the media by its full path in this project's `media/` folder. If you
   moved the project, or are on another computer, use Resolve's **Relink** to point it
   at the `media/` folder.

What comes across:

- **Video 1**: the main track, cut at whole frames exactly as in the editor, with clip
  labels as clip names.
- **Audio 1**: the main track's sound. Muted clips and clips without sound are gaps.
- **Voiceover**: the voiceover clips at their start times, ending with the main track.
- **Music** (and **Music 2**… when music clips overlap): the music clips at their start
  times, ending with the main track.
- **Still images** come across as clips of the image file, at their length. Resolve
  shows them without the zoom (it's kept in the clip's metadata); add a zoom in Resolve
  if you need one.
- **Speed changes** are included as OpenTimelineIO speed effects. Check them in Resolve.
- **Volume, mute, fades, fit and notes** are kept in each clip's metadata (and the
  ducking level in the timeline's), but Resolve doesn't apply them. Set levels and fades
  in Resolve's mixer; that's what the hand-off is for.

## Tests

```bash
npm test
```

The unit tests cover schema validation and error messages, timeline-to-source time
mapping (including speed changes), the edit operations (split, ripple delete, trim,
speed and volume, reorder, cutting a range), timecodes and frame stepping, ffprobe
parsing, peaks, snapshots, the change summary, and project helpers. The server tests
check that saving refuses to overwrite a file changed outside the editor, or an invalid
one, and that the file watcher pushes outside changes (and snapshots the old version)
but ignores the editor's own saves. The CLI tests run each `tl` command as a real
process, including finding the silent gap in generated test audio. The integration tests create
short test videos with ffmpeg (`testsrc` picture plus a `sine` tone with a silent gap)
and check proxy size and keyframe spacing, waveform peaks, the import API, and video
seeking (HTTP Range). Tests that need ffmpeg are skipped if it isn't installed.

The export is tested in two ways. Snapshot tests pin down the exact ffmpeg command and
filter graph built for a known timeline. The end-to-end test (`npm run e2e` runs it on
its own) generates a test video that turns black *and* silent at a known moment, exports
an edit with cuts, speed changes from 0.5× to 4×, a muted clip and a clip with no
sound, and then checks with ffmpeg's own detectors that the black and silent stretches
land exactly where the timeline puts them. That proves the cut points, the speed
changes and audio/video sync together. It also checks that the length matches the
timeline within one frame per clip.

Transcript tests check reading `transcript.json`, placing words on the timeline (with
speed changes and reordered clips), the highlighted-word lookup, cutting words (a
range of source time, across clips), and `tl words`. A real transcription test runs
faster-whisper on a recorded speech sample (`tests/fixtures/speech.wav`, made with
Windows text-to-speech) through the server; it only runs where faster-whisper and its
`base` model are already installed, so tests never download anything.

The music track has its own tests: moving, trimming and fading music clips, the
fade curve the player and export share, music in the change summary, importing an
audio file, and an end-to-end export where silent footage gets music that must be heard
only where the music track places it. The `.otio` hand-off is checked for its tracks,
whole-frame timing, gaps, music tracks and media links. If you point `OTIO_PYTHON` at a
Python that has the `opentimelineio` package, a further test loads the file with
OpenTimelineIO itself and checks every clip's position.

The voiceover track (`tests/voice.test.ts`) is checked for the file format (no
overlaps, the ducking range), the ducking curve, moving, trimming and cutting words out
of voiceover clips, importing a voiceover, the change summary, the export command and
the `.otio` Voiceover track. An end-to-end export plays a tone as music and a different
tone as the voiceover, separates the two again with filters, and measures the music
every 50 ms: it must be exactly 12 dB quieter while voice plays, and follow the player's
gain curve on the ramps (within 0.5 dB). The command-line tests import voiceover with
`--to voice` and list its words with `tl words`.

Still images (`tests/images.test.ts`) are checked for the file rules (in is 0, length
0.04–3600 s, no speed, main track only), the zoom function, splitting, cutting and
trimming image clips, fit and zoom settings, reading an image with ffprobe, the export
command and the `.otio` clips. An end-to-end export shows a black image with a white
square zooming from 1x to 2x around an off-centre point, and measures the square's edges
in the first, middle and last frames, to a fraction of a pixel: they must be within one
pixel of where the shared zoom function puts them, for both Final and preview exports.
The command-line pipeline test imports an image and exports it with Fill and a zoom.

Type checking: `npm run typecheck`.

## The timeline file

The format is described in SPEC.md section 5. The rules are defined once, as a zod
schema in [schema/timeline.ts](schema/timeline.ts), which the server (and later the
CLI) uses. [schema/timeline.schema.json](schema/timeline.schema.json) is generated from
it. After changing the zod schema, run:

```bash
npm run schema
```

A test fails if you forget.

## Project layout

```
app/        React browser editor (Vite)
server/     Fastify API, ffmpeg/ffprobe jobs (Node runs the .ts files directly)
cli/        command-line helpers for Claude (npm run tl)
schema/     timeline format: zod schema + generated JSON Schema, and sequence.ts
            (how clips are placed in time; shared by the player, CLI and export)
tests/      Vitest unit and integration tests
projects/<name>/
  media/      original footage: copied in on import, never modified
  proxies/    720p editing copies     (generated, safe to delete)
  peaks/      waveform data           (generated, safe to delete)
  exports/    rendered videos         (Milestone 4)
  history/    timeline snapshots      (safe to delete old ones)
  timeline.json
```

Settings, all optional, set as environment variables when you start the editor:
`PORT` (browser app, default 5173), `API_PORT` (default 5174), `PROJECTS_DIR`
(default `./projects`), `WHISPER_MODEL` (speech model: `tiny`, `base`, `small`,
`medium` or `large-v3`; default `small`; bigger is more accurate and slower),
`WHISPER_LANGUAGE` (for example `en`; default: detected), and `PYTHON` (the Python
command, default `python` on Windows and `python3` elsewhere).

## Decisions made so far

Where the spec left room, these are the simple choices made.

### Milestone 1

- **Import creates a clip.** Each imported video becomes a source *and* one main-track
  clip covering the whole file. The spec's editing operations (split, delete, trim)
  need clips to work on, and nothing else adds them.
- **Video files only.** A file with no video picture (for example an mp3) is refused
  for now. Music import belongs to Milestone 6.
- **Extra source metadata.** Sources store `width`, `height` and `audioChannels` from
  ffprobe alongside `duration` and `fps`. The project's `fps` and `resolution` are set
  from the first imported video.
- **Source time starts at 0** at the beginning of the file. Durations are rounded *down*
  to 3 decimals so a clip's `out` never points past the real end.
- **Source paths** must be inside `media/` and use forward slashes. **Source ids** may
  only use letters, digits, `-` and `_`, because generated file names are based on them.
- **Imported file names** are cleaned up: spaces and symbols become `_`, and a
  number is added if the name already exists (`clip-2.mov`).
- **Disk space:** before copying, the server checks that the drive has room for the
  file plus about 10% and 200 MB for its proxy. If it doesn't, the import is refused
  with a clear message. Files are never referenced in place.
- **Proxy:** H.264 at 720p (never upscaled), a keyframe every 8 frames, stereo AAC,
  `+faststart`. Rotated phone footage is turned upright.
- **Peaks:** `peaks/<file>.peaks.json` holds the loudest sample of every 1/100 s
  (0–255). The waveform is scaled to the file's loudest point.
- **Timecode:** `HH:MM:SS:FF` where HH:MM:SS is real clock time and FF counts frames
  within that second. For 29.97 fps this is not SMPTE drop-frame timecode.
- **Jobs run one at a time**, waveforms first, so a long proxy encode doesn't slow
  everything else down. Job state lives in memory. Files on disk are the record, so a
  restart regenerates anything missing.
- **The browser checked for changes every 1–2 seconds.** Milestone 3 replaced this
  with a file watcher and instant push updates.
- **Dependencies** beyond the spec's list: `@vitejs/plugin-react` (the standard React
  plugin for Vite) and `@types/*` type packages. Uploads and video seeking (HTTP Range)
  are handled in a few lines of our own code instead of extra Fastify plugins.

### Milestone 2

- **Saving never overwrites an outside change.** Each save tells the server which
  version of `timeline.json` it was based on (a hash of the file). If the file changed
  in the meantime, for example because Claude edited it, the server refuses the save.
  The editor then shows the file's version and says so, and Undo brings your change
  back. While the file on disk is invalid, editing is paused and nothing is written.
- **Outside changes are in the undo history.** When the editor picks up a changed file,
  your previous version is kept, so **Undo** reverts Claude's edit.
- **Typing and slider drags undo as one step.** Changes to the same field of the same
  clip within 1.5 seconds are merged in the undo history.
- **Split** copies the clip's settings, label and note to both halves.
- **Trim** keeps every clip at least one frame long and inside its source file.
- **Cutting a range** drops any leftover piece shorter than one frame.
- **Volume above 100%** uses the browser's Web Audio, which starts on your first
  play. Without it, volume still works up to 100%.
- **Playing backwards (J)** works by stepping the picture back, because browsers can't
  play video in reverse. It's smooth enough for finding a spot, not for watching.
- **Playback pauses when you switch to another browser tab.** Browsers slow down
  background tabs so much that cuts would be missed.
- **The player's raw-source view from Milestone 1 is gone.** The player now always
  plays the edited timeline, and every import adds a clip to it.
- **Where the code lives:** the edit operations are in `app/src/edits.ts`. Timeline
  timing (where each clip sits, and timeline-to-source time) is in
  `schema/sequence.ts`, so Milestone 4's export can use exactly the same rules.

### Milestone 3

- **Push updates use server-sent events** (a one-way stream from server to browser).
  The browser also checks every 10 seconds as a backup, and every second while a proxy
  or waveform is being prepared.
- **The editor recognises its own saves by content.** The server remembers the exact
  text it last wrote, so a file event with the same content is ignored. There's no
  timing window to get wrong.
- **The change summary is worked out in the browser** by comparing the old and new
  timelines by clip id. It shows up to 8 lines, plus the change in total length.
  Changes made by an import in the editor aren't announced as outside changes.
- **The message's Undo is offered until you make another edit**, since after that it
  would no longer undo just the outside change. **Ctrl+Z** still steps back through
  everything.
- **Snapshots are named** `YYYY-MM-DD_HH-MM-SS_<reason>.json` in local time, with reason
  `external`, `auto` or `manual`. Old ones are never deleted automatically.
- **The 5-minute snapshot is taken when you save**, at most every 5 minutes, so an idle
  editor doesn't fill `history/` with identical copies.
- **The helpers pick the project** from `--project`, the folder you run them from, or the
  only project there is. With several projects and none named, they stop and list them.
- **`tl silences` reports the sources used on the main track** (or every source if the
  track is empty), each range tagged with its `sourceId`. Its JSON goes to standard
  output and a one-line count per source to standard error.
- **The validation hook now uses `npm run tl -- validate`**, so Claude's edits are checked
  by exactly the same rules as the editor.
- **New dependency:** `chokidar` (file watching, as listed in the spec).

### Milestone 4

- **How the export reads the media.** Clips that play forward through the same file
  share one ffmpeg input, so a typical "remove pauses" edit reads each file once. Where
  the edit jumps back in a file (clips reordered), skips ahead more than 10 seconds, or
  changes file, a new input starts that seeks straight to the right spot. Measured on a
  10-minute 1080p file: 30 reordered clips read from one shared input needed 5.8 GB of
  memory; with this approach memory stays around 1–1.5 GB for normal edits, plus about
  25 MB per extra input.
- **The filter graph goes in a file** (`-/filter_complex`), because for long edits it
  is too long for a Windows command line. That option needs ffmpeg 7 or newer; with an
  older ffmpeg the export says so and what to do.
- **Every clip is scaled to the output size and frame rate** (`fps` filter), with black
  bars where the shape differs, so clips from different cameras join cleanly.
- **Audio is 48 kHz stereo** in every export.
- **Preview size:** the shorter side becomes 720 pixels (so vertical video becomes
  720×1280), never larger than the source.
- **Names** include the project, preset and local time. Two exports started in the same
  second get `-2` added.
- **A failed export** shows its reason in the Export panel and leaves no half-written
  video behind; its command file stays for troubleshooting.

### Milestone 5

- **One `transcript.json` per project**, with each source's words keyed by source id.
  It also records the file it was made from; if a source is later pointed at a
  different file, its old transcript is ignored. The `{}` placeholder counts as empty.
  A broken `transcript.json` is reported in the Transcript panel and replaced by the
  next transcription; it never stops the editor.
- **ffmpeg extracts the audio first** (16 kHz mono), the same way exports read media,
  so word times line up with source time. faster-whisper then runs with word
  timestamps and voice-activity detection, from a small script
  (`server/transcribe.py`), in the background job queue.
- **Graphics card or processor:** the script tries the graphics card and falls back to
  the processor automatically, saying so in the panel. On this machine the CUDA
  library `cublas64_12.dll` is missing, so the processor is used.
- **Default model `small`**: a good balance for interviews. `base` is faster and less
  accurate; `medium` is more accurate and much slower on a processor.
- **A word belongs to a clip when its middle is inside the clip.** That decides which
  words are struck through and where a word sits on the timeline.
- **Deleting words cuts from the first word's start to the next word's start**, so the
  pause after the selection goes too and the speech keeps its rhythm. Whisper tends to
  start the first word after a silence a little early (about 0.2 s), which makes such a
  cut begin slightly inside the silence before it; that is harmless.
- **Selecting words uses click and Shift+click** (not drag-selecting text). Selecting
  words clears the clip selection, and Delete cuts the words first.
- **Transcription is only started by you**, never automatically, because it can take
  a while. There's no command-line way to transcribe; `tl words` explains when a file
  has no transcript yet.

### Milestone 6

- **Audio files become music clips.** Importing a file with sound but no picture adds
  it as a source and puts a music clip covering the whole file at the start of the
  timeline, at 30% volume. Its proxy is an audio-only AAC file, so every browser can
  play it.
- **Music clips don't move with the main track.** They have an explicit start time (as
  the spec defines), so cutting or reordering the main track leaves them where they
  are. Splitting and range cuts (I/O) only affect the main track.
- **Fades are linear**, in the player and in the export (ffmpeg's `afade` default), and
  can't be longer than the clip together.
- **The export mixes music with `amix` and `normalize=0`**, so the main track's level
  isn't halved to make room. Music is cut off where the main track ends; music clips that
  start after the end are left out.
- **In the player**, each music clip plays from its own hidden audio element that
  follows the timeline clock, re-seeking if it drifts more than 0.2 s. Music is silent
  while playing backwards (J).
- **Hand-off format: OpenTimelineIO only.** The spec allows OTIO and/or FCPXML. OTIO is
  plain JSON (written directly, no new dependency) and DaVinci Resolve imports it. It
  was checked by loading it with the OpenTimelineIO library itself. FCPXML can be added
  later if needed.
- **The hand-off file ends with the main track**, like the export, and times are rounded
  to whole frames from the running timeline position so rounding never drifts.
- **Speed in the hand-off:** each clip keeps its length on the timeline, and the speed
  is an OpenTimelineIO `LinearTimeWarp` effect. Resolve's handling of OTIO speed
  effects can vary, so check sped-up clips after importing.

### Milestone 7 (v2: command line for pipelines)

- **Format version 2** is a superset of version 1. Only the version number changed in
  this milestone; the voice track and images come in Milestones 8 and 9. Everything that
  writes `timeline.json` writes version 2, and the first upgrade of a file keeps the
  version 1 copy in `history/`.
- **One importer for the browser and the command line** (`server/importer.ts`), so a
  file gets the same name, checks and placement however it arrives.
- **`tl set` refuses a timeline that points at files not in `media/`**: import first
  (`--to none` adds a file without placing it). This stops a pipeline delivering an edit
  with missing footage.
- **The command line never needs the server.** Proxies and waveforms are still made by
  the server when you open the project in the editor.
- **`--json` everywhere**, with progress messages on the error output so the JSON stays
  clean.
- **`tl import --to voice`** and **still images** say which milestone they arrive in,
  instead of failing in a confusing way.

### Milestone 8 (v2: voiceover track)

- **Voiceover clips have an explicit start, like music, and must not overlap.** The file
  check refuses overlaps; the editor stops a drag where clips touch and explains why.
- **Ducking follows clip positions, not the sound**, so one function
  (`duckGainAt` in `schema/sequence.ts`) decides the music level for the player, the
  timeline waveform and the export. The music level moves in decibels, linearly over
  0.25 s, and is fully down for the whole voiceover clip.
- **The export lowers music with ffmpeg's `volume` filter and a time expression** built
  from the same shape. ffmpeg only re-evaluates that expression once per block of
  samples, so the music is split into 5 ms blocks first; without that, ramps moved in
  steps of up to 85 ms.
- **Importing a voiceover places it after the last one** (or at `--at`), so narration
  files imported in order line up one after another. A start that would overlap is
  refused with the first free time.
- **Cutting words from a voiceover closes the gap in that clip only.** The part after the
  cut becomes a new clip that starts where the first part ends; other voiceover clips
  and the music don't move.
- **`tl transcribe` defaults to the voiceover's files** when there is a voiceover (that's
  the narration a pipeline needs words for), and to every file with sound otherwise.
- **Dropping an audio file asks "Voiceover or music?"**, defaulting to music as before.

### Milestone 9 (v2: still images)

- **One zoom function** (`zoomAt` / `zoomWindow` in `schema/sequence.ts`). The picture
  scales around the focus point, which stays put, so `focus` never pans and the zoomed
  picture never leaves the frame. The player does it with a CSS `scale` around that
  point; the export crops the same window.
- **The export zooms with ffmpeg's `perspective` filter**, not `zoompan` (which rounds to
  whole pixels and jitters) and not a size-changing `scale` (ffmpeg's `crop` keeps the
  first frame's size, so the window never moved). `perspective` samples the exact
  window every frame. Its frame counter starts at 1, which the end-to-end test caught:
  every frame was zoomed one frame ahead.
- **Final exports zoom at twice the size**, then scale down, so detail stays sharp when
  zoomed in; previews don't, to stay fast.
- **The browser gets a JPEG copy** of each image (at most 2560 pixels on the longer
  side), made like a video proxy; the export always reads the original.
- **Images don't set the project size or frame rate.** A photo's size is rarely the
  video's; without a set resolution, the export uses the first video's size.
- **Trimming an image keeps its zoom range** (from → to over the new length), while
  splitting and cutting divide it, so a split image looks exactly as before.
- **Transparent parts of PNGs aren't supported**: they show whatever colour the file
  stores under them (often black).
- **GIF, HEIC and AVIF are refused** with a message to save the image as PNG or JPEG.
