// Milestone 9: still images as main-track clips, with fit and a slow zoom, below the
// level of a real export (tests/e2e.test.ts measures exported frames).

import path from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeChanges } from "../app/src/changes.ts";
import { cutRange, splitAt, trimClip, updateClip } from "../app/src/edits.ts";
import { layoutMain, zoomAt, zoomWindow } from "../schema/sequence.ts";
import { validateTimeline, type MainClip, type Timeline } from "../schema/timeline.ts";
import { buildExport, zoomCorners } from "../server/export.ts";
import { parseProbe } from "../server/ffmpeg.ts";
import { buildOtio } from "../server/handoff.ts";
import { addImportedSource } from "../server/projects.ts";

const tl: Timeline = {
  version: 2,
  project: "demo",
  fps: 25,
  resolution: { width: 1080, height: 1920 },
  sources: [
    { id: "src1", path: "media/shot.mp4", duration: 10, fps: 25, width: 1920, height: 1080, audioChannels: 2 },
    { id: "img1", kind: "image", path: "media/still.png", width: 2048, height: 2048 },
  ],
  tracks: {
    main: [
      { id: "c1", sourceId: "src1", in: 0, out: 4, fit: "cover" },
      { id: "c2", sourceId: "img1", in: 0, out: 4, zoom: { from: 1, to: 1.2, focus: { x: 0.25, y: 0.5 } } },
    ],
  },
};
const withMain = (main: MainClip[]): Timeline => ({ ...tl, tracks: { main } });
const errorsOf = (t: Timeline) => {
  const r = validateTimeline(t);
  return r.ok ? [] : r.errors;
};

describe("timeline format: image sources and clips", () => {
  it("accepts image sources, fit and zoom", () => {
    expect(errorsOf(tl)).toEqual([]);
  });

  it("explains the rules for image clips", () => {
    const image = tl.tracks.main[1];
    expect(errorsOf(withMain([{ ...image, in: 1, out: 4 }]))).toEqual([
      'tracks.main[0] (clip "c2"): "in" must be 0 for an image clip ("out" is how long the image shows)',
    ]);
    expect(errorsOf(withMain([{ ...image, out: 4000 }]))[0]).toMatch(/"out" \(4000\) is how long the image shows, and must be between 0.04 and 3600/);
    expect(errorsOf(withMain([{ ...image, speed: 2 }]))[0]).toMatch(/"speed" must be 1 for an image clip/);
    expect(errorsOf(withMain([{ ...tl.tracks.main[0], zoom: { from: 1, to: 2 } }]))[0]).toMatch(/"zoom" only applies to image clips/);
    expect(errorsOf(withMain([{ ...image, zoom: { from: 1, to: 4 } }]))[0]).toMatch(/"to" must be between 1.0 and 3.0/);
    expect(errorsOf(withMain([{ ...image, fit: "stretch" as "cover" }]))[0]).toMatch(/"fit" must be "contain" or "cover"/);
  });

  it("keeps images off the voice and music tracks, and media fields off image sources", () => {
    const music = { ...tl, tracks: { main: [], music: [{ id: "m1", sourceId: "img1", start: 0, in: 0, out: 2 }] } };
    expect(errorsOf(music)[0]).toMatch(/"img1" is a still image, which can only go on the main track/);
    const withDuration = { ...tl, sources: [tl.sources[0], { ...tl.sources[1], duration: 5 }] };
    expect(errorsOf(withDuration)[0]).toMatch(/"duration" doesn't apply to an image source/);
  });
});

describe("zoom (shared by the player and the export)", () => {
  const image = tl.tracks.main[1];

  it("scales linearly over the clip, around the focus point", () => {
    expect(zoomAt(image, 0)).toBe(1);
    expect(zoomAt(image, 2)).toBeCloseTo(1.1, 9);
    expect(zoomAt(image, 4)).toBeCloseTo(1.2, 9);
    expect(zoomAt(image, 9)).toBeCloseTo(1.2, 9);
    expect(zoomAt(tl.tracks.main[0], 2)).toBe(1);
    const w = zoomWindow(image, 4);
    // The focus point (0.25 across) stays where it is: 0.25 of the window is left of it.
    expect(w.left + 0.25 * w.width).toBeCloseTo(0.25, 9);
    expect(w.top + 0.5 * w.height).toBeCloseTo(0.5, 9);
    expect(w.width).toBeCloseTo(1 / 1.2, 9);
  });

  it("builds the same window as ffmpeg perspective corners", () => {
    // perspective counts frames from 1, so frame `in` shows at (in - 1) / fps.
    expect(zoomCorners(image, 25)).toBe(
      "x0='(0.25*(W-W/(1+0.2*clip((in-1)/100,0,1))))':y0='(0.5*(H-H/(1+0.2*clip((in-1)/100,0,1))))':" +
        "x1='((0.25*(W-W/(1+0.2*clip((in-1)/100,0,1))))+W/(1+0.2*clip((in-1)/100,0,1)))':y1='(0.5*(H-H/(1+0.2*clip((in-1)/100,0,1))))':" +
        "x2='(0.25*(W-W/(1+0.2*clip((in-1)/100,0,1))))':y2='((0.5*(H-H/(1+0.2*clip((in-1)/100,0,1))))+H/(1+0.2*clip((in-1)/100,0,1)))':" +
        "x3='((0.25*(W-W/(1+0.2*clip((in-1)/100,0,1))))+W/(1+0.2*clip((in-1)/100,0,1)))':y3='((0.5*(H-H/(1+0.2*clip((in-1)/100,0,1))))+H/(1+0.2*clip((in-1)/100,0,1)))'",
    );
  });
});

describe("export and hand-off", () => {
  it("reads an image as a looped picture, fitted and zoomed, with silence", () => {
    const { args, graph } = buildExport(tl, "final", "o.mp4", "g.txt");
    expect(args.join(" ")).toContain("-loop 1 -framerate 25 -t 4 -i media/still.png");
    expect(graph.trim().split(";\n")).toMatchSnapshot();
  });

  it("sizes the export from the video, not from a photo", () => {
    const { graph } = buildExport({ ...tl, resolution: undefined }, "final", "o.mp4", "g.txt");
    expect(graph).toContain("scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080");
  });

  it("hands images to Resolve as clips with silence under them, zoom in metadata", () => {
    const otio = buildOtio(tl, path.resolve("/studio/projects/demo")) as {
      tracks: { children: { name: string; children: { OTIO_SCHEMA: string; name: string; metadata: Record<string, unknown> }[] }[] };
    };
    const [video, audio] = otio.tracks.children;
    expect(video.children.map((c) => c.OTIO_SCHEMA)).toEqual(["Clip.2", "Clip.2"]);
    expect(video.children[1].metadata["text-video-editor"]).toMatchObject({ still: true, zoom: { from: 1, to: 1.2, focus: { x: 0.25, y: 0.5 } } });
    expect(video.children[0].metadata["text-video-editor"]).toMatchObject({ fit: "cover" });
    expect(audio.children.map((c) => c.OTIO_SCHEMA)).toEqual(["Clip.2", "Gap.1"]);
  });
});

describe("editing image clips", () => {
  const main = (t: Timeline | null) => t!.tracks.main;

  it("changes how long an image shows from either edge", () => {
    expect(main(trimClip(tl, "c2", "out", 6.5))[1]).toMatchObject({ in: 0, out: 6.5 });
    expect(main(trimClip(tl, "c2", "in", 1))[1]).toMatchObject({ in: 0, out: 3 }); // left edge 1 s later
    expect(main(trimClip(tl, "c2", "out", 5000))[1]).toMatchObject({ out: 3600 });
    expect(main(trimClip(tl, "c2", "out", 0))[1]).toMatchObject({ out: 0.04 });
  });

  it("splits an image into two that keep zooming smoothly", () => {
    const split = main(splitAt(tl, 5)); // 1 s into the image
    expect(split.slice(1)).toEqual([
      { id: "c2", sourceId: "img1", in: 0, out: 1, zoom: { from: 1, to: 1.05, focus: { x: 0.25, y: 0.5 } } },
      { id: "c3", sourceId: "img1", in: 0, out: 3, zoom: { from: 1.05, to: 1.2, focus: { x: 0.25, y: 0.5 } } },
    ]);
    // The second part starts exactly where the first ends.
    const placed = layoutMain(withMain(split));
    expect(zoomAt(placed[2].clip, 0)).toBeCloseTo(zoomAt(tl.tracks.main[1], 1), 9);
  });

  it("cuts a range out of an image", () => {
    const cut = main(cutRange(tl, 5, 6)); // the image's 1–2 s
    expect(cut.slice(1).map((c) => [c.id, c.in, c.out, c.zoom?.from, c.zoom?.to])).toEqual([
      ["c2", 0, 1, 1, 1.05],
      ["c3", 0, 2, 1.1, 1.2],
    ]);
  });

  it("sets fit and zoom, and ignores speed and sound on images", () => {
    const zoomed = main(updateClip(tl, "c2", { zoomTo: 1.5, fit: "cover", speed: 2, volume: 0.5, muted: true }))[1];
    expect(zoomed).toEqual({ id: "c2", sourceId: "img1", in: 0, out: 4, fit: "cover", zoom: { from: 1, to: 1.5, focus: { x: 0.25, y: 0.5 } } });
    expect(main(updateClip(tl, "c2", { zoomTo: 1 }))[1].zoom).toBeUndefined(); // 1 → 1 is no zoom
    expect(main(updateClip(tl, "c2", { zoomTo: 9 }))[1].zoom?.to).toBe(3);
    expect(main(updateClip(tl, "c2", { focus: { x: 0.5, y: 0.5 } }))[1].zoom).toEqual({ from: 1, to: 1.2 });
    expect(main(updateClip(tl, "c1", { zoomTo: 2, fit: "contain" }))[0]).toEqual({ id: "c1", sourceId: "src1", in: 0, out: 4 });
  });

  it("describes fit and zoom changes for the outside-change message", () => {
    const next = updateClip(tl, "c2", { zoomTo: 1.5, fit: "cover" })!;
    expect(summarizeChanges(tl, next)).toEqual(["Fit of c2 at 00:00:04:00: contain → cover", "Zoom of c2 at 00:00:04:00: was 1×–1.2×, now 1×–1.5×"]);
  });
});

describe("importing images", () => {
  it("recognises a still image from ffprobe", () => {
    const png = { format: { format_name: "png_pipe" }, streams: [{ codec_type: "video", width: 800, height: 600 }] };
    expect(parseProbe(png)).toEqual({ duration: 0, hasVideo: true, image: true, width: 800, height: 600, audioChannels: 0 });
  });

  it("puts an image at the end of the main track for 3 seconds, without changing the project size", () => {
    const info = { duration: 0, hasVideo: true, image: true, width: 800, height: 600, audioChannels: 0 };
    const added = addImportedSource({ ...tl, resolution: undefined, fps: undefined, sources: [], tracks: { main: [] } }, "media/a.png", info);
    expect(added.source).toEqual({ id: "src1", kind: "image", path: "media/a.png", width: 800, height: 600 });
    expect(added.timeline.tracks.main).toEqual([{ id: "c1", sourceId: "src1", in: 0, out: 3 }]);
    expect(added.timeline.resolution).toBeUndefined();
    expect(validateTimeline(added.timeline).ok).toBe(true);
    expect(() => addImportedSource(tl, "media/a.png", info, { to: "voice" })).toThrow(/is a still image, so it can only go on the main track/);
  });
});
