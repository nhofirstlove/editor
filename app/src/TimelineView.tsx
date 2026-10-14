// The timeline: ruler, main track (clip blocks with waveforms), voiceover lane and music lane.
// Clip blocks are elements (for clicking and dragging); the ruler and waveforms are
// drawn on canvases the size of the visible area, so long timelines stay fast at any zoom.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { duckDb, duckGainAt, layoutMain, totalDuration, voiceSpans, type PlacedClip } from "../../schema/sequence.ts";
import { isImage, type MusicClip, type Timeline, type VoiceClip } from "../../schema/timeline.ts";
import type { PeaksFile } from "../../server/api-types.ts";
import { moveAudio, moveClip, trimAudio, trimClip, voiceOverlap, type AudioTrack } from "./edits.ts";
import { formatTimecode } from "../../schema/timecode.ts";

export type Marks = { in: number | null; out: number | null };

type Props = {
  timeline: Timeline;
  fps: number;
  time: number;
  playing: boolean;
  selectedId: string | null;
  marks: Marks;
  /** Waveform peaks by source id. */
  peaks: Record<string, PeaksFile | undefined>;
  /** Picture URLs of still-image sources, by source id, for their thumbnail strips. */
  thumbnails: Record<string, string | undefined>;
  editable: boolean;
  onSeek: (t: number) => void;
  onSelect: (clipId: string | null) => void;
  onEdit: (next: Timeline | null) => void;
};

const MAX_PPS = 400; // pixels per second: about 16 px per frame at 25 fps
const ZOOM_STEP = 1.5;
const END_PADDING = 120;
const DRAG_THRESHOLD = 4;
/** Ruler label spacing: whole frames when zoomed in, then seconds. */
const FRAME_STEPS = [1, 2, 5, 10];
const SECOND_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export function TimelineView(props: Props) {
  const { timeline, fps, time, playing, selectedId, marks, peaks, editable } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const rulerCanvas = useRef<HTMLCanvasElement>(null);
  const waveCanvas = useRef<HTMLCanvasElement>(null);
  const musicWaveCanvas = useRef<HTMLCanvasElement>(null);
  const voiceWaveCanvas = useRef<HTMLCanvasElement>(null);
  const pendingScroll = useRef<number | null>(null);

  const [viewWidth, setViewWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [pps, setPps] = useState<number | null>(null);
  /** Shown instead of `timeline` while a trim is being dragged. */
  const [draft, setDraft] = useState<Timeline | null>(null);
  const [drop, setDrop] = useState<{ from: number; before: number } | null>(null);
  /** Why the last drag on the voice lane stopped short. */
  const [hint, setHint] = useState<string | null>(null);

  const shown = draft ?? timeline;
  const stillIds = useMemo(() => new Set(timeline.sources.filter((s) => isImage(s)).map((s) => s.id)), [timeline.sources]);
  const placed = useMemo(() => layoutMain(shown), [shown]);
  const duration = totalDuration(placed);
  const fitPps = viewWidth > 0 ? (viewWidth - 40) / Math.max(duration, 1) : 50;
  const minPps = Math.min(fitPps, 1);
  const scale = pps ?? fitPps;
  const contentWidth = Math.max(viewWidth, duration * scale + END_PADDING);

  useEffect(() => {
    const el = scroller.current!;
    const observer = new ResizeObserver(() => setViewWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Start zoomed to fit, once there's something to show.
  useEffect(() => {
    if (pps === null && duration > 0 && viewWidth > 0) setPps(fitPps);
  }, [pps, duration, viewWidth, fitPps]);

  function zoomTo(next: number, anchorX = viewWidth / 2) {
    const clamped = Math.min(MAX_PPS, Math.max(minPps, next));
    const anchorTime = (scrollLeft + anchorX) / scale;
    pendingScroll.current = Math.max(0, anchorTime * clamped - anchorX);
    setPps(clamped);
  }

  useLayoutEffect(() => {
    if (pendingScroll.current !== null && scroller.current) {
      scroller.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
  });

  // Ctrl/Cmd + wheel zooms around the pointer; a plain wheel scrolls sideways.
  const zoomRef = useRef(zoomTo);
  zoomRef.current = zoomTo;
  useEffect(() => {
    const el = scroller.current!;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const anchor = e.clientX - el.getBoundingClientRect().left;
        zoomRef.current(scaleRef.current * (e.deltaY < 0 ? 1.2 : 1 / 1.2), anchor);
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scroller.current;
    if (!playing || !el) return;
    const x = time * scale;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - 40);
  }, [time, playing, scale]);

  // Ruler.
  useEffect(() => {
    const ctx = setUpCanvas(rulerCanvas.current, viewWidth);
    if (!ctx) return;
    const width = viewWidth;
    const height = ctx.canvas.clientHeight;
    const style = getComputedStyle(ctx.canvas);
    const steps = [...FRAME_STEPS.map((f) => f / fps), ...SECOND_STEPS];
    const major = steps.find((s) => s * scale >= 90) ?? 3600;
    const minor = major / 5;
    const showFrames = major < 1;
    const startT = scrollLeft / scale;
    const endT = (scrollLeft + width) / scale;
    ctx.strokeStyle = style.getPropertyValue("--ruler-tick");
    ctx.fillStyle = style.getPropertyValue("--ruler-text");
    ctx.font = "11px ui-monospace, Consolas, monospace";
    ctx.beginPath();
    if (minor * scale >= 6) {
      for (let t = Math.floor(startT / minor) * minor; t <= endT; t += minor) {
        const x = Math.round(t * scale - scrollLeft) + 0.5;
        ctx.moveTo(x, height - 5);
        ctx.lineTo(x, height);
      }
    }
    for (let i = Math.floor(startT / major); i * major <= endT; i++) {
      const t = i * major;
      const x = Math.round(t * scale - scrollLeft) + 0.5;
      ctx.moveTo(x, height - 12);
      ctx.lineTo(x, height);
      const tc = formatTimecode(t, fps);
      const label = showFrames ? tc : tc.slice(0, 8);
      ctx.fillText(duration < 3600 ? label.slice(3) : label, x + 3, 12);
    }
    ctx.stroke();
  }, [viewWidth, scrollLeft, scale, fps, duration]);

  // Waveforms inside main-track clips.
  const loudest = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [id, p] of Object.entries(peaks)) {
      let max = 1;
      for (const v of p?.peaks ?? []) if (v > max) max = v;
      out[id] = max;
    }
    return out;
  }, [peaks]);

  useEffect(() => {
    const segments = placed.map((p) => ({ sourceId: p.clip.sourceId, start: p.start, end: p.end, sourceIn: p.clip.in, speed: p.speed, muted: !!p.clip.muted }));
    drawWaveforms(waveCanvas.current, segments, peaks, loudest, { scale, scrollLeft, viewWidth });
  }, [placed, peaks, loudest, viewWidth, scrollLeft, scale]);

  // Waveforms inside voiceover and music clips. Music is drawn lower where it's ducked under voice.
  const voice = shown.tracks.voice ?? [];
  const music = shown.tracks.music ?? [];
  const db = duckDb(shown);
  useEffect(() => {
    drawWaveforms(voiceWaveCanvas.current, audioSegments(voice), peaks, loudest, { scale, scrollLeft, viewWidth });
  }, [voice, peaks, loudest, viewWidth, scrollLeft, scale]);
  useEffect(() => {
    const spans = voiceSpans(voice);
    const gainAt = (t: number) => duckGainAt(spans, db, t);
    drawWaveforms(musicWaveCanvas.current, audioSegments(music), peaks, loudest, { scale, scrollLeft, viewWidth }, gainAt);
  }, [music, voice, db, peaks, loudest, viewWidth, scrollLeft, scale]);

  function timeAt(clientX: number): number {
    const left = content.current!.getBoundingClientRect().left;
    return Math.min(duration, Math.max(0, (clientX - left) / scale));
  }

  /** Follows the pointer until it's released. */
  function drag(e: ReactPointerEvent, onMove: (ev: PointerEvent) => void, onUp: (ev: PointerEvent) => void) {
    e.preventDefault();
    const move = (ev: PointerEvent) => onMove(ev);
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onUp(ev);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function startSeek(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    props.onSeek(timeAt(e.clientX));
    drag(e, (ev) => props.onSeek(timeAt(ev.clientX)), () => {});
  }

  function startTrim(e: ReactPointerEvent, p: PlacedClip, edge: "in" | "out") {
    e.stopPropagation();
    if (!editable || e.button !== 0) return;
    props.onSelect(p.clip.id);
    const base = timeline;
    const startX = e.clientX;
    let latest: Timeline | null = null;
    drag(
      e,
      (ev) => {
        const sourceDelta = ((ev.clientX - startX) / scale) * p.speed;
        const value = (edge === "in" ? p.clip.in : p.clip.out) + sourceDelta;
        latest = trimClip(base, p.clip.id, edge, value);
        setDraft(latest ?? base);
      },
      () => {
        setDraft(null);
        if (latest) props.onEdit(latest);
      },
    );
  }

  function startMove(e: ReactPointerEvent, p: PlacedClip) {
    if (e.button !== 0) return;
    e.stopPropagation();
    props.onSelect(p.clip.id);
    if (!editable) return;
    const startX = e.clientX;
    let moving = false;
    let before = p.index;
    drag(
      e,
      (ev) => {
        if (!moving && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return;
        moving = true;
        const t = timeAt(ev.clientX);
        const i = placed.findIndex((q) => (q.start + q.end) / 2 > t);
        before = i === -1 ? placed.length : i;
        setDrop({ from: p.index, before });
      },
      () => {
        setDrop(null);
        if (moving) props.onEdit(moveClip(timeline, p.index, before));
      },
    );
  }

  /**
   * Dragging a voice or music clip moves its start; plain clicks just select it. A voice
   * clip stops where it would overlap another one (they can't overlap), with a hint.
   */
  function startMoveAudio(e: ReactPointerEvent, track: AudioTrack, m: MusicClip | VoiceClip) {
    if (e.button !== 0) return;
    e.stopPropagation();
    props.onSelect(m.id);
    if (!editable) return;
    const base = timeline;
    const startX = e.clientX;
    let moving = false;
    let latest: Timeline | null = null;
    setHint(null);
    drag(
      e,
      (ev) => {
        if (!moving && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return;
        moving = true;
        const start = m.start + (ev.clientX - startX) / scale;
        const next = moveAudio(base, track, m.id, start);
        if (next) latest = next;
        else if (track === "voice") refuseOverlap(base, { ...m, start: Math.max(0, start) });
        setDraft(latest ?? base);
      },
      () => {
        setDraft(null);
        if (latest) props.onEdit(latest);
      },
    );
  }

  function startTrimAudio(e: ReactPointerEvent, track: AudioTrack, m: MusicClip | VoiceClip, edge: "in" | "out") {
    e.stopPropagation();
    if (!editable || e.button !== 0) return;
    props.onSelect(m.id);
    const base = timeline;
    const startX = e.clientX;
    let latest: Timeline | null = null;
    setHint(null);
    drag(
      e,
      (ev) => {
        const delta = (ev.clientX - startX) / scale;
        const next = trimAudio(base, track, m.id, edge, (edge === "in" ? m.in : m.out) + delta);
        if (next) latest = next;
        else if (track === "voice") refuseOverlap(base, edge === "in" ? { ...m, in: m.in + delta, start: m.start + delta } : { ...m, out: m.out + delta });
        setDraft(latest ?? base);
      },
      () => {
        setDraft(null);
        if (latest) props.onEdit(latest);
      },
    );
  }

  function refuseOverlap(base: Timeline, wanted: VoiceClip) {
    const other = voiceOverlap(base, wanted);
    if (other) setHint(`Voiceover clips can't overlap: ${wanted.id} stops at ${other.id}.`);
  }

  /** A voiceover or music lane: clips placed at their start, with fades and a waveform. */
  function audioLane(track: AudioTrack, clips: (MusicClip | VoiceClip)[], canvas: typeof voiceWaveCanvas, empty: string) {
    return (
      <div className={`tl-track tl-audio-lane tl-${track}`} onPointerDown={(e) => e.button === 0 && props.onSelect(null)}>
        {clips.map((m) => {
          const width = (m.out - m.in) * scale;
          return (
            <div
              key={m.id}
              className={`tl-audio-clip ${track}${m.id === selectedId ? " selected" : ""}`}
              style={{ left: m.start * scale, width }}
              title={audioTooltip(track, m, fps)}
              onPointerDown={(e) => startMoveAudio(e, track, m)}
            >
              {m.fadeIn ? <div className="tl-fade in" style={{ width: m.fadeIn * scale }} /> : null}
              {m.fadeOut ? <div className="tl-fade out" style={{ width: m.fadeOut * scale }} /> : null}
              {width > 24 && (
                <div className="tl-clip-head">
                  <span className="tl-clip-name">{m.label ?? m.id}</span>
                  <span className="badge">{Math.round((m.volume ?? 1) * 100)}%</span>
                  {m.note && <span className="badge">note</span>}
                </div>
              )}
              {editable && (
                <>
                  <div className="tl-handle left" onPointerDown={(e) => startTrimAudio(e, track, m, "in")} />
                  <div className="tl-handle right" onPointerDown={(e) => startTrimAudio(e, track, m, "out")} />
                </>
              )}
            </div>
          );
        })}
        <canvas ref={canvas} className="tl-wave" style={{ left: scrollLeft, width: viewWidth }} />
        {clips.length === 0 && (
          <span className="tl-lane-label" style={{ left: scrollLeft + 6 }}>
            {empty}
          </span>
        )}
      </div>
    );
  }

  const dropX = drop ? (drop.before < placed.length ? placed[drop.before].start : duration) * scale : 0;
  const markIn = marks.in;
  const markOut = marks.out;

  return (
    <section className="timeline-panel">
      <div className="tl-toolbar">
        <button title="Zoom out (Ctrl + scroll)" onClick={() => zoomTo(scale / ZOOM_STEP)}>
          −
        </button>
        <button title="Zoom in (Ctrl + scroll)" onClick={() => zoomTo(scale * ZOOM_STEP)}>
          +
        </button>
        <button title="Fit the whole timeline" onClick={() => zoomTo(fitPps, 0)}>
          Fit
        </button>
        <span className="muted small">
          {timeline.tracks.main.length} clip{timeline.tracks.main.length === 1 ? "" : "s"} · {formatTimecode(duration, fps)}
          {db ? ` · music lowered ${-db} dB under voice` : ""}
        </span>
        {hint && <span className="small error-text">{hint}</span>}
      </div>
      <div className="tl-scroll" ref={scroller} onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}>
        <div className="tl-content" ref={content} style={{ width: contentWidth }}>
          <div className="tl-ruler" onPointerDown={startSeek}>
            <canvas ref={rulerCanvas} style={{ left: scrollLeft, width: viewWidth }} />
          </div>

          <div className="tl-track tl-main" onPointerDown={(e) => e.button === 0 && props.onSelect(null)}>
            {placed.map((p) => {
              const c = p.clip;
              const width = (p.end - p.start) * scale;
              const image = stillIds.has(c.sourceId);
              const thumb = props.thumbnails[c.sourceId];
              return (
                <div
                  key={c.id}
                  className={`tl-clip${image ? " still" : ""}${c.id === selectedId ? " selected" : ""}${c.muted ? " muted" : ""}${drop?.from === p.index ? " dragging" : ""}`}
                  style={{ left: p.start * scale, width, backgroundImage: image && thumb ? `url("${thumb}")` : undefined }}
                  title={clipTooltip(p, fps, image)}
                  onPointerDown={(e) => startMove(e, p)}
                >
                  {width > 24 && (
                    <div className="tl-clip-head">
                      <span className="tl-clip-name">{c.label ?? c.id}</span>
                      {image && <span className="badge">still</span>}
                      {image && c.zoom && <span className="badge">zoom</span>}
                      {(c.speed ?? 1) !== 1 && <span className="badge">{c.speed}×</span>}
                      {c.muted && <span className="badge">muted</span>}
                      {c.note && <span className="badge">note</span>}
                    </div>
                  )}
                  {editable && (
                    <>
                      <div className="tl-handle left" onPointerDown={(e) => startTrim(e, p, "in")} />
                      <div className="tl-handle right" onPointerDown={(e) => startTrim(e, p, "out")} />
                    </>
                  )}
                </div>
              );
            })}
            <canvas ref={waveCanvas} className="tl-wave" style={{ left: scrollLeft, width: viewWidth }} />
            {timeline.tracks.main.length === 0 && <div className="tl-empty">Import a video to start. Each import adds a clip here.</div>}
          </div>

          {audioLane("voice", voice, voiceWaveCanvas, "Voiceover: import an audio file and choose Voiceover to add it here")}
          {audioLane("music", music, musicWaveCanvas, "Music: import an audio file (mp3, wav, m4a…) to add it here")}

          {markIn !== null && markOut !== null && markOut > markIn && (
            <div className="tl-range" style={{ left: markIn * scale, width: (markOut - markIn) * scale }} />
          )}
          {markIn !== null && <div className="tl-mark" style={{ left: markIn * scale }} title="In mark (I)" />}
          {markOut !== null && <div className="tl-mark" style={{ left: markOut * scale }} title="Out mark (O)" />}
          {drop && <div className="tl-drop" style={{ left: dropX }} />}
          <div className="tl-playhead" style={{ left: time * scale }}>
            <div className="tl-playhead-handle" onPointerDown={startSeek} />
          </div>
        </div>
      </div>
    </section>
  );
}

function audioTooltip(track: AudioTrack, m: MusicClip | VoiceClip, fps: number): string {
  const lines = [
    `${m.id}${m.label ? ` · ${m.label}` : ""} (${track === "voice" ? "voiceover" : "music"})`,
    `Timeline ${formatTimecode(m.start, fps)} – ${formatTimecode(m.start + m.out - m.in, fps)}`,
    `Source ${m.sourceId}: ${m.in.toFixed(3)} s – ${m.out.toFixed(3)} s`,
    `Volume ${Math.round((m.volume ?? 1) * 100)}% · fade in ${m.fadeIn ?? 0} s · fade out ${m.fadeOut ?? 0} s`,
  ];
  if (m.note) lines.push(`Note: ${m.note}`);
  return lines.join("\n");
}

type WaveSegment = { sourceId: string; start: number; end: number; sourceIn: number; speed: number; muted: boolean };

function audioSegments(clips: (MusicClip | VoiceClip)[]): WaveSegment[] {
  return clips.map((m) => ({ sourceId: m.sourceId, start: m.start, end: m.start + m.out - m.in, sourceIn: m.in, speed: 1, muted: false }));
}

/**
 * Draws each segment's waveform (from precomputed peaks) on a canvas the size of the
 * visible area. `gainAt` scales it by timeline time (music ducked under voice).
 */
function drawWaveforms(
  canvas: HTMLCanvasElement | null,
  segments: WaveSegment[],
  peaks: Record<string, PeaksFile | undefined>,
  loudest: Record<string, number>,
  view: { scale: number; scrollLeft: number; viewWidth: number },
  gainAt?: (t: number) => number,
): void {
  const { scale, scrollLeft, viewWidth } = view;
  const ctx = setUpCanvas(canvas, viewWidth);
  if (!ctx) return;
  const style = getComputedStyle(ctx.canvas);
  const mid = ctx.canvas.clientHeight / 2;
  for (const seg of segments) {
    const data = peaks[seg.sourceId];
    if (!data) continue;
    const x0 = Math.max(0, Math.ceil(seg.start * scale - scrollLeft) + 1);
    const x1 = Math.min(viewWidth, Math.floor(seg.end * scale - scrollLeft) - 1);
    if (x1 <= x0) continue;
    ctx.fillStyle = style.getPropertyValue(seg.muted ? "--wave-muted" : "--wave");
    const max = loudest[seg.sourceId] ?? 255;
    for (let x = x0; x < x1; x++) {
      // Source-time window covered by this pixel column.
      const t0 = seg.sourceIn + ((x + scrollLeft) / scale - seg.start) * seg.speed;
      const t1 = t0 + seg.speed / scale;
      const from = Math.floor(t0 * data.peaksPerSecond);
      const to = Math.max(from + 1, Math.floor(t1 * data.peaksPerSecond));
      let v = 0;
      for (let i = from; i < to && i < data.peaks.length; i++) if (data.peaks[i] > v) v = data.peaks[i];
      const h = (v / max) * (mid - 6) * (gainAt ? gainAt((x + 0.5 + scrollLeft) / scale) : 1);
      ctx.fillRect(x, mid - h, 1, Math.max(1, h * 2));
    }
  }
}

function clipTooltip(p: PlacedClip, fps: number, image: boolean): string {
  const c = p.clip;
  const lines = [
    `${c.id}${c.label ? ` · ${c.label}` : ""}${image ? " (still image)" : ""}`,
    `Timeline ${formatTimecode(p.start, fps)} – ${formatTimecode(p.end, fps)}`,
    image
      ? `Image ${c.sourceId}, shown for ${c.out.toFixed(3)} s${c.zoom ? ` · zoom ${c.zoom.from}× → ${c.zoom.to}×` : ""}`
      : `Source ${c.sourceId}: ${c.in.toFixed(3)} s – ${c.out.toFixed(3)} s`,
    image ? `Fit: ${c.fit ?? "contain"}` : `Speed ${c.speed ?? 1}× · Volume ${Math.round((c.volume ?? 1) * 100)}%${c.muted ? " · muted" : ""}`,
  ];
  if (c.note) lines.push(`Note: ${c.note}`);
  return lines.join("\n");
}

/** Sizes a canvas for the screen's pixel density and clears it. */
function setUpCanvas(canvas: HTMLCanvasElement | null, cssWidth: number): CanvasRenderingContext2D | null {
  if (!canvas || cssWidth <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const cssHeight = canvas.clientHeight;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return ctx;
}
