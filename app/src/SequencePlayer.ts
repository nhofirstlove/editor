// Plays the edited sequence using two <video> elements, double-buffered: the front one
// plays the current clip while the hidden back one waits, already seeked to the start
// of the next clip. At the cut the two swap, so cuts play with minimal stutter.
//
// Timeline time is the master clock. While playing forward it is read from the front
// video; while paused or playing backward (J) it is set directly. Still images show in
// an <img> layer instead, zoomed with the shared zoomWindow function (the same window
// the export crops), and the clock runs from the system timer while one is on screen.

import { duckGainAt, locate, timelineTimeOf, totalDuration, voiceSpans, zoomWindow, type PlacedClip } from "../../schema/sequence.ts";
import type { MusicClip, VoiceClip } from "../../schema/timeline.ts";
import { MusicMixer } from "./MusicMixer.ts";

type Slot = {
  el: HTMLVideoElement;
  /** Volume control through Web Audio, which (unlike el.volume) can boost above 100%. */
  gain: GainNode | null;
  url: string | null;
  clip: PlacedClip | null;
};

/**
 * The tracks placed at explicit times, the ducking setting (tracks.mix.duckMusicUnderVoice),
 * and which sources are still images.
 */
export type SequenceExtras = { music?: MusicClip[]; voice?: VoiceClip[]; duckDb?: number; stills?: ReadonlySet<string> };

export type PlayerEvents = {
  onTime: (t: number) => void;
  /** rate: 0 when paused, 1/2/4/8 forward, -1/-2/-4/-8 backward. */
  onRate: (rate: number) => void;
};

/** Switch a hair before the out point; a display refresh is ~16 ms. */
const CUT_LEAD_SECONDS = 0.012;
/**
 * Backup clock. Animation frames stop when the window isn't being drawn (covered by
 * another window), but the video keeps playing; this timer keeps cuts on time anyway.
 */
const BACKUP_TICK_MS = 40;
const MAX_PLAYBACK_RATE = 16;

export class SequencePlayer {
  private slots: [Slot, Slot];
  private front = 0;
  private placed: PlacedClip[] = [];
  private urls: Record<string, string | undefined> = {};
  private time = 0;
  private rate = 0;
  private raf = 0;
  private backup: ReturnType<typeof setInterval> | undefined;
  private lastFrameAt = 0;
  private audio: AudioContext | null = null;
  private events: PlayerEvents;
  private music = new MusicMixer();
  private voice = new MusicMixer();
  private still: HTMLImageElement;
  private stills: ReadonlySet<string> = new Set();
  /** The image clip on screen, or null while a video (or nothing) is showing. */
  private showingStill: PlacedClip | null = null;

  constructor(a: HTMLVideoElement, b: HTMLVideoElement, still: HTMLImageElement, events: PlayerEvents) {
    const slot = (el: HTMLVideoElement): Slot => {
      el.preservesPitch = true;
      el.preload = "auto";
      el.playsInline = true;
      return { el, gain: null, url: null, clip: null };
    };
    this.slots = [slot(a), slot(b)];
    this.still = still;
    this.events = events;
    this.updateVisibility();
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  get currentTime(): number {
    return this.time;
  }

  get duration(): number {
    return totalDuration(this.placed);
  }

  get playbackRate(): number {
    return this.rate;
  }

  /** Called whenever the timeline or the available proxies change. Keeps playing if it was. */
  setSequence(placed: PlacedClip[], urls: Record<string, string | undefined>, audio: SequenceExtras = {}): void {
    this.placed = placed;
    this.urls = urls;
    this.stills = audio.stills ?? new Set();
    const spans = voiceSpans(audio.voice);
    const db = audio.duckDb ?? 0;
    this.music.setClips(audio.music ?? [], urls, (t) => duckGainAt(spans, db, t));
    this.voice.setClips(audio.voice ?? [], urls);
    this.time = Math.min(this.time, this.duration);
    if (this.rate !== 0 && !placed.length) this.pause();
    this.show(true);
    this.events.onTime(this.time);
  }

  seek(t: number): void {
    this.time = Math.min(Math.max(0, t), this.duration);
    this.show(false);
    this.updateAudio(this.rate > 0 ? this.rate : 0);
    this.events.onTime(this.time);
  }

  play(rate = 1): void {
    if (!this.placed.length || rate === 0) return;
    this.setUpAudio();
    if (rate > 0 && this.time >= this.duration - 0.001) this.time = 0;
    if (rate < 0 && this.time <= 0) return;
    this.rate = rate;
    this.show(false);
    this.lastFrameAt = performance.now();
    this.stopClock();
    this.raf = requestAnimationFrame(this.onFrame);
    this.backup = setInterval(() => this.step(performance.now()), BACKUP_TICK_MS);
    this.updateAudio(rate > 0 ? rate : 0);
    this.events.onRate(rate);
  }

  pause(): void {
    this.stopClock();
    this.rate = 0;
    for (const s of this.slots) s.el.pause();
    this.music.pauseAll();
    this.voice.pauseAll();
    this.events.onRate(0);
    this.events.onTime(this.time);
  }

  destroy(): void {
    this.stopClock();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    for (const s of this.slots) s.el.pause();
    this.music.destroy();
    this.voice.destroy();
    void this.audio?.close();
  }

  private updateAudio(rate: number): void {
    this.music.update(this.time, rate);
    this.voice.update(this.time, rate);
  }

  private stopClock(): void {
    cancelAnimationFrame(this.raf);
    clearInterval(this.backup);
  }

  /** In a hidden tab, timers slow to once a second and cuts would be missed, so stop. */
  private onVisibilityChange = (): void => {
    if (document.hidden && this.rate !== 0) this.pause();
  };

  private onFrame = (now: number): void => {
    this.step(now);
    if (this.rate !== 0) this.raf = requestAnimationFrame(this.onFrame);
  };

  /** Advances the clock; runs on every animation frame and on the backup timer. */
  private step(now: number): void {
    if (this.rate === 0) return;
    const dt = (now - this.lastFrameAt) / 1000;
    this.lastFrameAt = now;
    if (this.rate > 0 && this.showingStill) {
      // A still image: the system clock moves time on, and the zoom follows.
      const p = this.showingStill;
      this.time = Math.min(p.end, this.time + dt * this.rate);
      if (this.time >= p.end - 1e-6) {
        const next = this.placed[p.index + 1];
        if (!next) {
          this.time = this.duration;
          return this.pause();
        }
        this.time = next.start;
        this.show(false);
      } else {
        this.drawStill(p, this.time - p.start);
      }
    } else if (this.rate > 0) {
      const front = this.slots[this.front];
      const p = front.clip;
      if (!p || !front.url) return this.pause();
      const cur = front.el.currentTime;
      if (front.el.ended || cur >= p.clip.out - CUT_LEAD_SECONDS * p.speed * this.rate) {
        const next = this.placed[p.index + 1];
        if (!next) {
          this.time = this.duration;
          return this.pause();
        }
        this.time = next.start;
        if (this.isStill(next)) this.show(false);
        else this.cutTo(next);
      } else if (!front.el.seeking) {
        this.time = Math.min(p.end, Math.max(p.start, timelineTimeOf(p, cur)));
      }
    } else if (this.rate < 0) {
      // Browsers can't play video backwards, so step the picture back by seeking.
      this.time = Math.max(0, this.time + dt * this.rate);
      if (this.showingStill || !this.slots[this.front].el.seeking) this.show(false);
      if (this.time <= 0) return this.pause();
    }
    this.updateAudio(this.rate > 0 ? this.rate : 0);
    this.events.onTime(this.time);
  }

  /** At a cut: start the preloaded back element and bring it to the front. */
  private cutTo(next: PlacedClip): void {
    const back = this.slots[1 - this.front];
    if (!this.holds(back, next, next.clip.in)) return this.show(false);
    const old = this.slots[this.front];
    this.front = 1 - this.front;
    this.applyClipSettings(back, next);
    this.playElement(back.el);
    this.updateVisibility();
    old.el.pause();
    this.preload(old, this.placed[next.index + 1]);
  }

  /**
   * Puts the clip at the current time in the front element and preloads the next clip
   * behind it. `gentle` avoids re-seeking a playing video that is already in the right place.
   */
  private show(gentle: boolean): void {
    const hit = locate(this.placed, this.time);
    if (!hit) {
      this.showingStill = null;
      for (const s of this.slots) this.unload(s);
      this.updateVisibility();
      return;
    }
    const want = hit.placed;
    if (this.isStill(want)) {
      // Videos wait (the next one preloaded behind) while the image shows.
      this.showingStill = want;
      for (const s of this.slots) s.el.pause();
      this.preload(this.slots[1 - this.front], this.placed[want.index + 1]);
      this.drawStill(want, hit.sourceTime);
      this.updateVisibility();
      return;
    }
    this.showingStill = null;
    // If the back element already holds this clip (e.g. seeking just past a cut), use it.
    const back = this.slots[1 - this.front];
    if (!this.holds(this.slots[this.front], want) && this.holds(back, want)) this.front = 1 - this.front;
    const front = this.slots[this.front];

    this.load(front, want, hit.sourceTime, gentle && this.rate > 0);
    this.applyClipSettings(front, want);
    this.preload(this.slots[1 - this.front], this.placed[want.index + 1]);
    this.updateVisibility();
    if (this.rate > 0 && front.url) this.playElement(front.el);
    else front.el.pause();
  }

  private urlFor(p: PlacedClip): string | null {
    return this.urls[p.clip.sourceId] ?? null;
  }

  private isStill(p: PlacedClip): boolean {
    return this.stills.has(p.clip.sourceId);
  }

  /** Shows an image clip `local` seconds in: fitted like a video, scaled around the zoom's focus. */
  private drawStill(p: PlacedClip, local: number): void {
    const url = this.urlFor(p);
    if (!url) return;
    const el = this.still;
    if (el.getAttribute("src") !== url) el.src = url;
    const zoom = zoomWindow(p.clip, local);
    el.style.objectFit = p.clip.fit ?? "contain";
    // Scaling around this origin keeps the focus point in place, which is exactly the
    // window zoomWindow describes (left = focus x × (1 − 1 / scale)).
    el.style.transformOrigin = `${(p.clip.zoom?.focus?.x ?? 0.5) * 100}% ${(p.clip.zoom?.focus?.y ?? 0.5) * 100}%`;
    el.style.transform = zoom.scale === 1 ? "" : `scale(${zoom.scale})`;
  }

  /** Whether a slot is loaded with this clip's source (and, if given, sitting at `sourceTime`). */
  private holds(slot: Slot, p: PlacedClip, sourceTime?: number): boolean {
    if (!slot.clip || slot.url === null || slot.url !== this.urlFor(p)) return false;
    if (slot.clip.clip.in !== p.clip.in || slot.clip.clip.out !== p.clip.out) return false;
    return sourceTime === undefined || Math.abs(slot.el.currentTime - sourceTime) < 0.02;
  }

  private load(slot: Slot, p: PlacedClip, sourceTime: number, gentle: boolean): void {
    const url = this.urlFor(p);
    slot.clip = p;
    if (!url) return this.unload(slot, p);
    if (slot.url !== url) {
      slot.el.src = url;
      slot.url = url;
    }
    // Before the video has loaded, this sets where it will start.
    if (!gentle || Math.abs(slot.el.currentTime - sourceTime) > 0.25) slot.el.currentTime = sourceTime;
  }

  private preload(slot: Slot, p: PlacedClip | undefined): void {
    slot.el.pause();
    if (!p || this.isStill(p)) {
      slot.clip = null;
      return;
    }
    if (!this.holds(slot, p, p.clip.in)) this.load(slot, p, p.clip.in, false);
    this.silence(slot);
  }

  private unload(slot: Slot, p: PlacedClip | null = null): void {
    slot.clip = p;
    if (slot.url !== null) {
      slot.el.pause();
      slot.el.removeAttribute("src");
      slot.el.load();
      slot.url = null;
    }
  }

  private applyClipSettings(slot: Slot, p: PlacedClip): void {
    slot.el.style.objectFit = p.clip.fit ?? "contain";
    const shuttle = this.rate > 0 ? this.rate : 1;
    slot.el.playbackRate = Math.min(MAX_PLAYBACK_RATE, p.speed * shuttle);
    slot.el.preservesPitch = true;
    const volume = p.clip.muted ? 0 : (p.clip.volume ?? 1);
    if (slot.gain) {
      slot.gain.gain.value = volume;
      slot.el.volume = 1;
      slot.el.muted = false;
    } else {
      slot.el.volume = Math.min(1, volume);
      slot.el.muted = volume === 0;
    }
  }

  private silence(slot: Slot): void {
    if (slot.gain) slot.gain.gain.value = 0;
    slot.el.muted = true;
  }

  private playElement(el: HTMLVideoElement): void {
    el.play().catch((err: DOMException) => {
      // AbortError just means a newer seek or source change interrupted this play().
      if (err.name === "NotAllowedError") this.pause();
    });
  }

  private updateVisibility(): void {
    const still = this.showingStill;
    this.slots.forEach((s, i) => {
      s.el.style.visibility = !still && i === this.front && s.url ? "visible" : "hidden";
    });
    this.still.style.visibility = still && this.urlFor(still) ? "visible" : "hidden";
  }

  /** Created on the first play (browsers only allow audio after a click or key press). */
  private setUpAudio(): void {
    if (this.audio) {
      if (this.audio.state === "suspended") void this.audio.resume();
      return;
    }
    try {
      const ctx = new AudioContext();
      for (const s of this.slots) {
        const gain = ctx.createGain();
        ctx.createMediaElementSource(s.el).connect(gain).connect(ctx.destination);
        s.gain = gain;
      }
      this.audio = ctx;
      this.music.useAudioContext(ctx);
      this.voice.useAudioContext(ctx);
    } catch {
      // Without Web Audio, volume still works up to 100%.
    }
  }
}
