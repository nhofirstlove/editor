// Frame and timecode helpers. Times are seconds; fps may be fractional (29.97).

const EPSILON = 1e-6;

/** Index of the frame shown at time `t`. */
export function frameAt(t: number, fps: number): number {
  return Math.floor(Math.max(0, t) * fps + EPSILON);
}

/**
 * The time to seek to for showing frame `frame`: its middle, so rounding in the
 * browser can't land on the frame before.
 */
export function frameTime(frame: number, fps: number): number {
  return (Math.max(0, frame) + 0.5) / fps;
}

/**
 * HH:MM:SS:FF. Hours, minutes and seconds are real clock time; FF counts frames within
 * the current second (0 to fps - 1). For 29.97 fps this is not SMPTE drop-frame.
 */
export function formatTimecode(t: number, fps: number): string {
  const time = Number.isFinite(t) && t > 0 ? t : 0;
  const whole = Math.floor(time + EPSILON);
  const maxFrame = Math.ceil(fps - EPSILON) - 1;
  const ff = Math.min(maxFrame, Math.max(0, Math.floor((time - whole) * fps + EPSILON)));
  const hh = Math.floor(whole / 3600);
  const mm = Math.floor((whole % 3600) / 60);
  const ss = whole % 60;
  return [hh, mm, ss, ff].map((n) => String(n).padStart(2, "0")).join(":");
}
