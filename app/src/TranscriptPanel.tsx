// The transcript of each file in the edit (main track first, then voiceover). Words play
// in sync with the player; words cut from the edit stay visible, struck through, so cuts
// can be reviewed.

import { memo, useEffect, useMemo, useRef } from "react";
import type { PlacedClip } from "../../schema/sequence.ts";
import type { Source } from "../../schema/timeline.ts";
import { clipPlaying, wordIndexAt, wordsFor, type Transcript, type Word } from "../../schema/transcript.ts";
import type { MediaStatus } from "../../server/api-types.ts";

/**
 * A run of selected words in one source, from `anchor` to `focus` (word indexes). `track`
 * says which clips a cut applies to: the main track's, or the voiceover's.
 */
export type WordSelection = { track: "main" | "voice"; sourceId: string; anchor: number; focus: number };

type Here = { sourceId: string; sourceTime: number } | null;

/** A pause at least this long between words starts a new paragraph. */
const PARAGRAPH_GAP = 1.5;

type Props = {
  sources: Source[];
  placed: PlacedClip[];
  /** Voiceover clips, laid out by layoutVoice. */
  voicePlaced: PlacedClip[];
  transcript: Transcript | null;
  media: Record<string, MediaStatus>;
  /** null while unknown; otherwise whether transcription is installed. */
  transcriber: { ok: true } | { ok: false; message: string } | null;
  /** The source and source time under the playhead, on the main track and the voiceover lane. */
  here: Here;
  hereVoice: Here;
  playing: boolean;
  selection: WordSelection | null;
  editable: boolean;
  onWordClick: (track: WordSelection["track"], sourceId: string, index: number, extend: boolean) => void;
  onTranscribe: (sourceId: string) => void;
  onCutSelection: () => void;
};

export function TranscriptPanel(props: Props) {
  const { placed, voicePlaced, transcript, media, transcriber, selection } = props;
  // Files in the edit, in the order they first appear: the main track's, then the voiceover's.
  const used = useMemo(() => {
    const list = (track: WordSelection["track"], clips: PlacedClip[]) =>
      [...new Set(clips.map((p) => p.clip.sourceId))]
        .map((id) => props.sources.find((s) => s.id === id))
        .filter((s): s is Source => !!s)
        .map((source) => ({ track, source, clips }));
    return [...list("main", placed), ...list("voice", voicePlaced)];
  }, [placed, voicePlaced, props.sources]);

  const selected = selection ? Math.abs(selection.focus - selection.anchor) + 1 : 0;

  return (
    <section className="panel transcript-panel">
      <div className="panel-head">
        <h2>Transcript</h2>
        <span className="muted small">Click a word to jump to it · Shift+click to select · Delete cuts the selection</span>
      </div>
      {transcriber && !transcriber.ok && <p className="muted small">{transcriber.message}</p>}
      {selected > 0 && (
        <div className="selection-bar small">
          {selected} word{selected === 1 ? "" : "s"} selected.{" "}
          <button onClick={props.onCutSelection} disabled={!props.editable}>
            Cut from the edit (Delete)
          </button>
        </div>
      )}
      {used.length === 0 && <p className="muted small">Add a clip to the timeline to see its transcript here.</p>}
      <div className="transcript-scroll">
        {used.map(({ track, source, clips }) => {
          const status = media[source.id]?.transcript;
          const words = wordsFor(transcript, source.id, source.path);
          const here = track === "voice" ? props.hereVoice : props.here;
          const showName = used.length > 1 || track === "voice";
          return (
            <div key={`${track}:${source.id}`} className="transcript-source">
              {showName && (
                <div className="small muted transcript-file">
                  {track === "voice" && <span className="badge">voiceover</span>} {source.path.replace(/^media\//, "")}
                </div>
              )}
              {words ? (
                <SourceWords
                  track={track}
                  source={source}
                  words={words}
                  placed={clips}
                  current={here?.sourceId === source.id ? wordIndexAt(words, here.sourceTime) : -1}
                  follow={props.playing}
                  selection={selection?.sourceId === source.id && selection.track === track ? selection : null}
                  onWordClick={props.onWordClick}
                />
              ) : (
                <TranscribeStatus
                  status={status}
                  canTranscribe={!!transcriber?.ok}
                  onTranscribe={() => props.onTranscribe(source.id)}
                />
              )}
              {words && status?.status === "ready" && (
                <button className="link small" onClick={() => props.onTranscribe(source.id)} disabled={!transcriber?.ok}>
                  Transcribe again
                </button>
              )}
              {words && (status?.status === "running" || status?.status === "queued") && <TranscribeStatus status={status} canTranscribe={false} onTranscribe={() => {}} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TranscribeStatus(props: { status: MediaStatus["transcript"] | undefined; canTranscribe: boolean; onTranscribe: () => void }) {
  const s = props.status;
  if (!s) return null;
  if (s.status === "no-audio") return <p className="muted small">This file has no audio track.</p>;
  if (s.status === "queued") return <p className="muted small">Waiting for other work to finish…</p>;
  if (s.status === "running") {
    return (
      <div className="job">
        <div className="small">{s.progress > 0 ? `Transcribing… ${Math.round(s.progress * 100)}%` : "Getting ready to transcribe…"}</div>
        {s.note && <div className="small muted">{s.note}</div>}
        <div className="progress">
          <div style={{ width: `${Math.round(s.progress * 100)}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div>
      {s.error && <p className="small error-text">{s.error}</p>}
      <button onClick={props.onTranscribe} disabled={!props.canTranscribe}>
        {s.status === "failed" ? "Try again" : "Transcribe"}
      </button>{" "}
      <span className="muted small">Runs on this computer with faster-whisper; long files take a while.</span>
    </div>
  );
}

type WordsProps = {
  track: WordSelection["track"];
  source: Source;
  words: Word[];
  placed: PlacedClip[];
  current: number;
  follow: boolean;
  selection: WordSelection | null;
  onWordClick: Props["onWordClick"];
};

/** Re-renders only when the words, the edit, the current word or the selection change. */
const SourceWords = memo(function SourceWords({ track, source, words, placed, current, follow, selection, onWordClick }: WordsProps) {
  const box = useRef<HTMLDivElement>(null);
  const inEdit = useMemo(() => words.map((w) => clipPlaying(placed, source.id, w) !== null), [words, placed, source.id]);
  const paragraphs = useMemo(() => {
    const out: number[][] = [];
    words.forEach((w, i) => {
      if (i === 0 || w.start - words[i - 1].end >= PARAGRAPH_GAP) out.push([]);
      out[out.length - 1].push(i);
    });
    return out;
  }, [words]);
  const [selFrom, selTo] = selection ? [Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus)] : [-1, -1];

  // While playing, keep the current word in view inside the transcript box.
  useEffect(() => {
    if (!follow || current < 0) return;
    const scroller = box.current?.closest(".transcript-scroll") as HTMLElement | null;
    const el = box.current?.querySelector(`[data-i="${current}"]`) as HTMLElement | null;
    if (!scroller || !el) return;
    const top = el.offsetTop; // the scroll box is the words' offset parent
    if (top < scroller.scrollTop || top > scroller.scrollTop + scroller.clientHeight - 30) scroller.scrollTop = top - scroller.clientHeight / 3;
  }, [current, follow]);

  return (
    <div ref={box} className="words">
      {paragraphs.map((para, p) => (
        <p key={p}>
          {para.map((i) => (
            <span key={i}>
              <span
                data-i={i}
                className={`word${inEdit[i] ? "" : " removed"}${i === current ? " current" : ""}${i >= selFrom && i <= selTo ? " selected" : ""}`}
                title={`${words[i].start.toFixed(2)}–${words[i].end.toFixed(2)} s in the source${inEdit[i] ? "" : " (cut from the edit)"}`}
                onClick={(e) => onWordClick(track, source.id, i, e.shiftKey)}
              >
                {words[i].text}
              </span>{" "}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
});
