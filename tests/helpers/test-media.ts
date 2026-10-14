// Generates small test clips with ffmpeg (testsrc picture + sine tone with a silent gap).

import { spawnSync } from "node:child_process";
import { checkTools } from "../../server/ffmpeg.ts";

export const hasFfmpeg = checkTools().ok;

type Options = { seconds?: number; width?: number; height?: number; fps?: number; audio?: boolean; silence?: [number, number] };

export function makeTestVideo(file: string, opts: Options = {}): void {
  const { seconds = 4, width = 1920, height = 1080, fps = 25, audio = true, silence = [1.5, 2.5] } = opts;
  const args = ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${width}x${height}:rate=${fps}:duration=${seconds}`];
  if (audio) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`);
    args.push("-af", `volume=enable='between(t,${silence[0]},${silence[1]})':volume=0`, "-c:a", "aac");
  }
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "250", file);
  const run = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`Could not make test video: ${run.stderr}`);
}
