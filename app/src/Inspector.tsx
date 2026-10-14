import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PlacedClip } from "../../schema/sequence.ts";
import {
  IMAGE_MAX_SECONDS,
  IMAGE_MIN_SECONDS,
  isImage,
  round3,
  ZOOM_MAX,
  ZOOM_MIN,
  type MainClip,
  type MusicClip,
  type Timeline,
  type VoiceClip,
} from "../../schema/timeline.ts";
import {
  moveAudio,
  setDucking,
  SPEED_MAX,
  SPEED_MIN,
  trimAudio,
  trimClip,
  updateAudio,
  updateClip,
  voiceOverlap,
  VOLUME_MAX,
  type AudioChanges,
  type AudioTrack,
  type ClipChanges,
} from "./edits.ts";
import { formatTimecode } from "../../schema/timecode.ts";

const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const DUCK_PRESETS = [0, -6, -12, -18];

type Props = {
  timeline: Timeline;
  placed: PlacedClip | null;
  fps: number;
  editable: boolean;
  onEdit: (next: Timeline | null, mergeKey?: string) => void;
  onDelete: () => void;
};

/** Shows and edits the selected clip's in, out, speed, volume, mute, label and note. */
export function Inspector({ timeline, placed, fps, editable, onEdit, onDelete }: Props) {
  const [customSpeed, setCustomSpeed] = useState(false);
  const clip = placed?.clip;
  useEffect(() => setCustomSpeed(false), [clip?.id]);

  if (!placed || !clip) {
    return (
      <div className="panel inspector">
        <h2>Clip</h2>
        <p className="muted small">Click a clip on the timeline to see and change its settings.</p>
        <MixSettings timeline={timeline} editable={editable} onEdit={onEdit} />
      </div>
    );
  }

  const source = timeline.sources.find((s) => s.id === clip.sourceId);
  const sourceFps = source?.fps ?? fps;
  const image = isImage(source);
  const speed = clip.speed ?? 1;
  const volume = clip.volume ?? 1;
  const change = (changes: ClipChanges, mergeKey?: string) => onEdit(updateClip(timeline, clip.id, changes), mergeKey);

  return (
    <div className="panel inspector">
      <h2>
        {image ? "Still image" : "Clip"} <span className="muted">{clip.id}</span>
      </h2>
      <div className="muted small">
        Timeline {formatTimecode(placed.start, fps)} – {formatTimecode(placed.end, fps)} ({(placed.end - placed.start).toFixed(2)} s)
      </div>

      <fieldset disabled={!editable}>
        {image ? (
          <>
            <label>
              Shows for <span className="muted small">(s)</span>
              <SecondsField
                value={clip.out}
                min={IMAGE_MIN_SECONDS}
                max={IMAGE_MAX_SECONDS}
                onCommit={(v) => onEdit(trimClip(timeline, clip.id, "out", v))}
              />
            </label>
            <ZoomFields clip={clip} onChange={change} />
          </>
        ) : (
          <>
            <div className="field-row">
              <label>
                In <span className="muted small">(source s)</span>
                <SecondsField value={clip.in} onCommit={(v) => onEdit(trimClip(timeline, clip.id, "in", v))} />
                <span className="muted small tc">{formatTimecode(clip.in, sourceFps)}</span>
              </label>
              <label>
                Out <span className="muted small">(source s)</span>
                <SecondsField value={clip.out} onCommit={(v) => onEdit(trimClip(timeline, clip.id, "out", v))} />
                <span className="muted small tc">{formatTimecode(clip.out, sourceFps)}</span>
              </label>
            </div>

            <label>
              Speed
              <div className="row">
                <select
                  value={customSpeed || !SPEED_PRESETS.includes(speed) ? "custom" : String(speed)}
                  onChange={(e) => {
                    if (e.target.value === "custom") setCustomSpeed(true);
                    else {
                      setCustomSpeed(false);
                      change({ speed: Number(e.target.value) });
                    }
                  }}
                >
                  {SPEED_PRESETS.map((s) => (
                    <option key={s} value={s}>
                      {s}×
                    </option>
                  ))}
                  <option value="custom">Custom…</option>
                </select>
                {(customSpeed || !SPEED_PRESETS.includes(speed)) && (
                  <SecondsField value={speed} min={SPEED_MIN} max={SPEED_MAX} onCommit={(v) => change({ speed: v })} suffix="×" />
                )}
              </div>
            </label>

            <label>
              Volume <span className="muted small">{Math.round(volume * 100)}%</span>
              <div className="row">
                <input
                  type="range"
                  min={0}
                  max={VOLUME_MAX}
                  step={0.05}
                  value={volume}
                  onChange={(e) => change({ volume: Number(e.target.value) }, `volume:${clip.id}`)}
                />
                <label className="check">
                  <input type="checkbox" checked={clip.muted ?? false} onChange={(e) => change({ muted: e.target.checked })} /> Mute (M)
                </label>
              </div>
            </label>
          </>
        )}

        <label>
          Fit
          <select value={clip.fit ?? "contain"} onChange={(e) => change({ fit: e.target.value as MainClip["fit"] })}>
            <option value="contain">Whole picture (black bars if the shape differs)</option>
            <option value="cover">Fill the frame (crop the edges)</option>
          </select>
        </label>

        <label>
          Label
          <input type="text" value={clip.label ?? ""} placeholder="e.g. Intro" onChange={(e) => change({ label: e.target.value }, `label:${clip.id}`)} />
        </label>

        <label>
          Note
          <textarea
            rows={3}
            value={clip.note ?? ""}
            placeholder="e.g. Keep this answer"
            onChange={(e) => change({ note: e.target.value }, `note:${clip.id}`)}
          />
        </label>

        <button className="danger" onClick={onDelete}>
          Delete clip (Del)
        </button>
      </fieldset>
    </div>
  );
}

/** An image clip's slow zoom: scale at the start and end, and the point that stays put. */
function ZoomFields({ clip, onChange }: { clip: MainClip; onChange: (changes: ClipChanges) => void }) {
  const zoom = clip.zoom;
  const focus = zoom?.focus ?? { x: 0.5, y: 0.5 };
  return (
    <>
      <div className="field-row">
        <label>
          Zoom from
          <SecondsField value={zoom?.from ?? 1} min={ZOOM_MIN} max={ZOOM_MAX} suffix="×" onCommit={(v) => onChange({ zoomFrom: v })} />
        </label>
        <label>
          Zoom to
          <SecondsField value={zoom?.to ?? 1} min={ZOOM_MIN} max={ZOOM_MAX} suffix="×" onCommit={(v) => onChange({ zoomTo: v })} />
        </label>
      </div>
      {zoom && (
        <div className="field-row">
          <label>
            Zoom centre across <span className="muted small">(0–1)</span>
            <SecondsField value={focus.x} min={0} max={1} onCommit={(v) => onChange({ focus: { x: v, y: focus.y } })} />
          </label>
          <label>
            down <span className="muted small">(0–1)</span>
            <SecondsField value={focus.y} min={0} max={1} onCommit={(v) => onChange({ focus: { x: focus.x, y: v } })} />
          </label>
        </div>
      )}
      <p className="muted small">1× is no zoom. For example 1 → 1.15 moves in slowly over the whole clip.</p>
    </>
  );
}

/** A number box that applies its value on Enter or when it loses focus; Escape cancels. */
function SecondsField(props: { value: number; min?: number; max?: number; suffix?: string; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(props.value));
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing) setText(String(props.value));
  }, [props.value, editing]);

  function commit() {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      setText(String(props.value));
      return;
    }
    const v = Number(text);
    if (text.trim() !== "" && Number.isFinite(v) && v !== props.value) props.onCommit(v);
    else setText(String(props.value));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      cancelled.current = true;
      e.currentTarget.blur();
    }
  }

  return (
    <span className="number-field">
      <input
        type="number"
        step={0.001}
        min={props.min}
        max={props.max}
        value={text}
        onFocus={() => setEditing(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      {props.suffix}
    </span>
  );
}

/** Project-wide mix settings, shown when no clip is selected. */
function MixSettings({ timeline, editable, onEdit }: { timeline: Timeline; editable: boolean; onEdit: Props["onEdit"] }) {
  const db = timeline.tracks.mix?.duckMusicUnderVoice ?? 0;
  const options = DUCK_PRESETS.includes(db) ? DUCK_PRESETS : [...DUCK_PRESETS, db].sort((a, b) => b - a);
  return (
    <fieldset disabled={!editable} className="mix-settings">
      <h3>Mix</h3>
      <label>
        Lower music under voice
        <select value={db} onChange={(e) => onEdit(setDucking(timeline, Number(e.target.value)))}>
          {options.map((v) => (
            <option key={v} value={v}>
              {v === 0 ? "off" : `${formatDb(v)} dB`}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        While a voiceover clip plays, music is turned down by this much, easing down and back up over a quarter of a second.
      </p>
    </fieldset>
  );
}

function formatDb(v: number): string {
  return v < 0 ? `\u2212${-v}` : String(v);
}

type AudioProps = {
  timeline: Timeline;
  track: AudioTrack;
  clip: MusicClip | VoiceClip;
  fps: number;
  editable: boolean;
  onEdit: (next: Timeline | null, mergeKey?: string) => void;
  onDelete: () => void;
};

/** Shows and edits the selected voice or music clip: start, in, out, volume, fades, label and note. */
export function AudioInspector({ timeline, track, clip: m, fps, editable, onEdit, onDelete }: AudioProps) {
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => setRefused(null), [m.id]);
  const name = track === "voice" ? "Voiceover" : "Music";
  const change = (changes: AudioChanges, mergeKey?: string) => onEdit(updateAudio(timeline, track, m.id, changes), mergeKey);
  /** Applies a move or trim. Voice clips can't overlap, so say why when one is refused. */
  const place = (next: Timeline | null, wanted: Partial<VoiceClip>) => {
    const other = !next && track === "voice" ? voiceOverlap(timeline, { ...m, ...wanted }) : null;
    setRefused(other ? `That would overlap voiceover clip ${other.id}. Voiceover clips can't overlap; pick a time when no other one plays.` : null);
    if (next) onEdit(next);
  };
  const volume = m.volume ?? 1;
  const length = m.out - m.in;
  return (
    <div className="panel inspector">
      <h2>
        {name} <span className="muted">{m.id}</span>
      </h2>
      <div className="muted small">
        Timeline {formatTimecode(m.start, fps)} – {formatTimecode(m.start + length, fps)} ({length.toFixed(2)} s). Drag it on the
        timeline to move it; drag its edges to trim.
      </div>
      {refused && <p className="small error-text">{refused}</p>}

      <fieldset disabled={!editable}>
        <label>
          Starts at <span className="muted small">(timeline s)</span>
          <SecondsField value={m.start} onCommit={(v) => place(moveAudio(timeline, track, m.id, v), { start: round3(Math.max(0, v)) })} />
        </label>
        <div className="field-row">
          <label>
            In <span className="muted small">(source s)</span>
            <SecondsField
              value={m.in}
              onCommit={(v) => place(trimAudio(timeline, track, m.id, "in", v), { in: v, start: m.start + v - m.in })}
            />
          </label>
          <label>
            Out <span className="muted small">(source s)</span>
            <SecondsField value={m.out} onCommit={(v) => place(trimAudio(timeline, track, m.id, "out", v), { out: v })} />
          </label>
        </div>

        <label>
          Volume <span className="muted small">{Math.round(volume * 100)}%</span>
          <input
            type="range"
            min={0}
            max={VOLUME_MAX}
            step={0.05}
            value={volume}
            onChange={(e) => change({ volume: Number(e.target.value) }, `${track}-volume:${m.id}`)}
          />
        </label>

        <div className="field-row">
          <label>
            Fade in <span className="muted small">(s)</span>
            <SecondsField value={m.fadeIn ?? 0} min={0} onCommit={(v) => change({ fadeIn: v })} />
          </label>
          <label>
            Fade out <span className="muted small">(s)</span>
            <SecondsField value={m.fadeOut ?? 0} min={0} onCommit={(v) => change({ fadeOut: v })} />
          </label>
        </div>

        <label>
          Label
          <input
            type="text"
            value={m.label ?? ""}
            placeholder={track === "voice" ? "e.g. Intro narration" : "e.g. Music bed"}
            onChange={(e) => change({ label: e.target.value }, `${track}-label:${m.id}`)}
          />
        </label>

        <label>
          Note
          <textarea rows={2} value={m.note ?? ""} onChange={(e) => change({ note: e.target.value }, `${track}-note:${m.id}`)} />
        </label>

        <button className="danger" onClick={onDelete}>
          Remove {track === "voice" ? "voiceover" : "music"} clip (Del)
        </button>
      </fieldset>
    </div>
  );
}
