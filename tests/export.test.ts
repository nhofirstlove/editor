import { describe, expect, it } from "vitest";
import type { Timeline } from "../schema/timeline.ts";
import { atempoChain, buildExport, formatCommand, outputSize } from "../server/export.ts";

const tl: Timeline = {
  version: 1,
  project: "demo",
  fps: 25,
  resolution: { width: 1920, height: 1080 },
  sources: [
    { id: "src1", path: "media/interview.mp4", duration: 600, fps: 25, width: 1920, height: 1080, audioChannels: 2 },
    { id: "src2", path: "media/broll.mov", duration: 30, fps: 30, width: 1080, height: 1920, audioChannels: 0 },
  ],
  tracks: {
    main: [
      { id: "c1", sourceId: "src1", in: 0, out: 12.4, label: "Intro" },
      { id: "c2", sourceId: "src1", in: 15.8, out: 42.1, speed: 1.25 },
      { id: "c3", sourceId: "src2", in: 2, out: 6 },
      { id: "c4", sourceId: "src1", in: 50, out: 63.5, volume: 0.8, muted: true },
      { id: "c5", sourceId: "src1", in: 64, out: 70, speed: 4, volume: 1.5 },
      { id: "c6", sourceId: "src1", in: 10, out: 12, speed: 0.25 },
    ],
  },
};

const inputsOf = (args: string[]) => args.flatMap((a, i) => (a === "-i" ? [`${args[i - 3]}+${args[i - 1]} ${args[i + 1]}`] : []));

describe("export command builder", () => {
  it("builds the expected command and filter graph", () => {
    const { args, graph } = buildExport(tl, "final", "exports/out.mp4", "exports/out.filtergraph.txt");
    expect(formatCommand(args)).toMatchSnapshot();
    expect(graph).toMatchSnapshot();
  });

  it("uses the preview encoder settings at 720p", () => {
    const { args, graph } = buildExport(tl, "preview", "exports/p.mp4", "g.txt");
    expect(args.join(" ")).toContain("-preset veryfast -crf 26");
    expect(graph).toContain("scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:");
  });

  it("reads forward-playing clips from one input, and starts a new one when the edit jumps", () => {
    // c1, c2 share an input; c3 switches file; c4, c5 go forward again (gap 0.5 s);
    // c6 jumps back to 10 s, so it gets its own input.
    expect(inputsOf(buildExport(tl, "final", "o.mp4", "g.txt").args)).toEqual([
      "0+42.1 media/interview.mp4",
      "2+4 media/broll.mov",
      "50+20 media/interview.mp4",
      "10+2 media/interview.mp4",
    ]);
  });

  it("seeks instead of decoding through a long gap", () => {
    const sparse: Timeline = {
      ...tl,
      tracks: { main: [{ id: "a", sourceId: "src1", in: 0, out: 5 }, { id: "b", sourceId: "src1", in: 100, out: 105 }] },
    };
    expect(inputsOf(buildExport(sparse, "final", "o.mp4", "g.txt").args)).toEqual(["0+5 media/interview.mp4", "100+5 media/interview.mp4"]);
  });

  it("gives muted clips and silent sources silence of the clip's exact length", () => {
    const { graph } = buildExport(tl, "final", "o.mp4", "g.txt");
    expect(graph).toContain("anullsrc=r=48000:cl=stereo,atrim=duration=13.5,"); // c4 muted
    expect(graph).toContain("anullsrc=r=48000:cl=stereo,atrim=duration=4,"); // c3 has no audio
    expect(graph).not.toContain("volume=0.8"); // muted wins over volume
  });

  it("mixes the music track under the main track's sound", () => {
    const withMusic: Timeline = {
      ...tl,
      sources: [...tl.sources, { id: "song", path: "media/song.mp3", duration: 180, audioChannels: 2 }],
      tracks: {
        ...tl.tracks,
        music: [
          { id: "m1", sourceId: "song", start: 0, in: 10, out: 40, volume: 0.3, fadeIn: 1, fadeOut: 2 },
          { id: "m2", sourceId: "song", start: 30.5, in: 0, out: 5 },
          { id: "m3", sourceId: "song", start: 9999, in: 0, out: 5 }, // after the end: left out
        ],
      },
    };
    const { args, graph } = buildExport(withMusic, "final", "o.mp4", "g.txt");
    expect(inputsOf(args).slice(-2)).toEqual(["10+30 media/song.mp3", "0+5 media/song.mp3"]);
    const lines = graph.trim().split("\n");
    expect(lines.slice(-4)).toMatchSnapshot();
    expect(graph).toContain("concat=n=6:v=1:a=1[outv][dialog]");
    expect(graph).toContain("[dialog][m0][m1]amix=inputs=3:duration=first:normalize=0,");
    expect(graph).not.toContain("m2]");
  });

  it("refuses an empty timeline", () => {
    expect(() => buildExport({ ...tl, tracks: { main: [] } }, "final", "o.mp4", "g.txt")).toThrow(/nothing to export/);
  });
});

describe("atempoChain", () => {
  it.each([
    [1, []],
    [1.25, ["atempo=1.25"]],
    [0.75, ["atempo=0.75"]],
    [2, ["atempo=2"]],
    [3, ["atempo=2", "atempo=1.5"]],
    [4, ["atempo=2", "atempo=2"]],
    [0.4, ["atempo=0.5", "atempo=0.8"]],
    [0.25, ["atempo=0.5", "atempo=0.5"]],
  ])("speed %s uses %j", (speed, chain) => {
    expect(atempoChain(speed)).toEqual(chain);
    // Each step stays within what old ffmpeg versions accept, and they multiply to the speed.
    const factors = chain.map((f) => Number(f.split("=")[1]));
    expect(factors.every((f) => f >= 0.5 && f <= 2)).toBe(true);
    expect(factors.reduce((a, b) => a * b, 1)).toBeCloseTo(speed, 9);
  });
});

describe("outputSize", () => {
  it("uses the timeline resolution for final, and 720 on the shorter side for previews", () => {
    expect(outputSize(tl, "final")).toEqual({ width: 1920, height: 1080 });
    expect(outputSize(tl, "preview")).toEqual({ width: 1280, height: 720 });
    const vertical = { ...tl, resolution: { width: 1280, height: 2274 } };
    expect(outputSize(vertical, "preview")).toEqual({ width: 720, height: 1280 });
  });

  it("never upscales a preview, and keeps sizes even", () => {
    expect(outputSize({ ...tl, resolution: { width: 641, height: 359 } }, "preview")).toEqual({ width: 642, height: 360 });
  });

  it("falls back to the first used source's size", () => {
    expect(outputSize({ ...tl, resolution: undefined }, "final")).toEqual({ width: 1920, height: 1080 });
  });
});

describe("formatCommand", () => {
  it("quotes arguments that need it", () => {
    expect(formatCommand(["-i", "media/a b.mp4", "-map", "[outv]", "out.mp4"])).toBe('ffmpeg -i "media/a b.mp4" -map "[outv]" out.mp4');
  });
});
