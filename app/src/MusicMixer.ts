// Plays an audio track placed at explicit times (music or voiceover) alongside the edited
// sequence: one hidden <audio> element per clip, started, stopped, seeked and faded to
// follow timeline time. Fades, volume and music ducking use the shared functions in
// schema/sequence.ts, the same curves as the export.

import { musicGainAt } from "../../schema/sequence.ts";
import type { MusicClip, VoiceClip } from "../../schema/timeline.ts";

type Player = { el: HTMLAudioElement; gain: GainNode | null; url: string };

/** Extra factor for the whole track at timeline time t (music ducking under voice). */
export type TrackGain = (t: number) => number;

/** Re-seek a clip that has drifted this far from where the timeline says it should be. */
const MAX_DRIFT = 0.2;

export class MusicMixer {
  private players = new Map<string, Player>();
  private clips: (MusicClip | VoiceClip)[] = [];
  private trackGain: TrackGain = () => 1;
  private urls: Record<string, string | undefined> = {};
  private audio: AudioContext | null = null;

  setClips(clips: (MusicClip | VoiceClip)[], urls: Record<string, string | undefined>, trackGain?: TrackGain): void {
    this.clips = clips;
    this.urls = urls;
    this.trackGain = trackGain ?? (() => 1);
    for (const [id, player] of this.players) {
      if (!clips.some((m) => m.id === id)) {
        player.el.pause();
        player.el.removeAttribute("src");
        this.players.delete(id);
      }
    }
  }

  /** Lets clips go above 100% volume, once the player has started Web Audio. */
  useAudioContext(ctx: AudioContext): void {
    this.audio = ctx;
    for (const player of this.players.values()) this.connect(player);
  }

  /**
   * Brings every clip in line with timeline time `t`. `rate` is the playback rate
   * when playing forward, or 0 when paused or shuttling backwards (the track is silent then).
   */
  update(t: number, rate: number): void {
    for (const m of this.clips) {
      const local = t - m.start;
      const url = this.urls[m.sourceId];
      const active = rate > 0 && !!url && local >= 0 && local < m.out - m.in;
      let player = this.players.get(m.id);
      if (!active) {
        if (player && !player.el.paused) player.el.pause();
        continue;
      }
      if (!player || player.url !== url) player = this.createPlayer(m.id, url!);
      const want = m.in + local;
      if (Math.abs(player.el.currentTime - want) > MAX_DRIFT) player.el.currentTime = want;
      player.el.playbackRate = rate;
      const gain = musicGainAt(m, local) * this.trackGain(t);
      if (player.gain) player.gain.gain.value = gain;
      else player.el.volume = Math.min(1, gain);
      if (player.el.paused) player.el.play().catch(() => {});
    }
  }

  pauseAll(): void {
    for (const player of this.players.values()) player.el.pause();
  }

  destroy(): void {
    for (const player of this.players.values()) {
      player.el.pause();
      player.el.removeAttribute("src");
    }
    this.players.clear();
  }

  private createPlayer(id: string, url: string): Player {
    this.players.get(id)?.el.pause();
    const el = new Audio();
    el.preload = "auto";
    el.preservesPitch = true;
    el.src = url;
    const player: Player = { el, gain: null, url };
    this.connect(player);
    this.players.set(id, player);
    return player;
  }

  private connect(player: Player): void {
    if (!this.audio || player.gain) return;
    try {
      const gain = this.audio.createGain();
      this.audio.createMediaElementSource(player.el).connect(gain).connect(this.audio.destination);
      player.gain = gain;
      player.el.volume = 1;
    } catch {
      // Without Web Audio, volume still works up to 100%.
    }
  }
}
