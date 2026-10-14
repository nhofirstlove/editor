---
name: export
description: Render a project's timeline to a video file in exports/. Only run when the user types /export.
argument-hint: "[project-name] [final | preview, default preview]"
disable-model-invocation: true
---

# Export

Render `projects/<name>/timeline.json` to a video in `projects/<name>/exports/`.

Arguments: `$ARGUMENTS` — a project name and a preset: `preview` (720p, fast; the
default) or `final` (source resolution, H.264, high quality, AAC audio). If there's no
project name and `projects/` holds more than one project, ask which one.

## Requirements
- `preview`: `npm run tl -- export --preview` (or `npm run tl -- preview`).
- `final`: `npm run tl -- export --final`.
Add `--project <name>` when there are several projects. Never build an ffmpeg command
by hand; the export command saves the exact command it used next to the video.

## Steps
1. `npm run tl -- validate <timeline path>`. If it fails, stop and report the errors.
2. `npm run tl -- summary` and `npm run tl -- duration`, so the result can be checked.
3. Run the export. It renders from the original files in `media/` and only reads
   them. Output goes to `exports/` only, never to `media/` or `proxies/`.
4. Check the output with `ffprobe`: duration should match the timeline duration within
   one frame per clip, and both video and audio streams should be present.
5. Report: the output path, its duration against the timeline duration, the preset,
   and the path of the saved ffmpeg command file next to the export.
