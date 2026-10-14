import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { duckDb, layoutMain, layoutVoice, locate, locateVoice, totalDuration } from "../../schema/sequence.ts";
import { isImage } from "../../schema/timeline.ts";
import { wordsFor, wordTimelineStart, type Transcript } from "../../schema/transcript.ts";
import type { HealthResponse, PeaksFile } from "../../server/api-types.ts";
import { api, importFile } from "./api.ts";
import { cutRange, cutSourceRange, cutVoiceSourceRange, removeAudio, rippleDelete, splitAt, updateClip } from "./edits.ts";
import { ExportPanel } from "./ExportPanel.tsx";
import { AudioInspector, Inspector } from "./Inspector.tsx";
import { MediaPanel } from "./MediaPanel.tsx";
import { SequencePlayer } from "./SequencePlayer.ts";
import { formatTimecode, frameAt, frameTime } from "../../schema/timecode.ts";
import { TimelineView, type Marks } from "./TimelineView.tsx";
import { TranscriptPanel, type WordSelection } from "./TranscriptPanel.tsx";
import { useTimelineDoc } from "./useTimelineDoc.ts";

const DEFAULT_FPS = 25;

type SideTab = "transcript" | "clip" | "media" | "export";
const SIDE_TABS: Array<[SideTab, string]> = [
  ["transcript", "Transcript"],
  ["clip", "Clip"],
  ["media", "Media"],
  ["export", "Export"],
];
const NO_MARKS: Marks = { in: null, out: null };
/** Files the browser reports as sound only; importing one asks "Voiceover or music?". */
const AUDIO_FILE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|aif|aiff|wma)$/i;

export function ProjectView({ name }: { name: string }) {
  const doc = useTimelineDoc(name);
  const { timeline, server } = doc;

  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const stillImage = useRef<HTMLImageElement>(null);
  const player = useRef<SequencePlayer | null>(null);
  const [time, setTime] = useState(0);
  const [rate, setRate] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  const [upload, setUpload] = useState<{ file: string; progress: number } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [peaks, setPeaks] = useState<Record<string, PeaksFile | undefined>>({});
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [transcriber, setTranscriber] = useState<HealthResponse["transcriber"] | null>(null);
  const [wordSel, setWordSel] = useState<WordSelection | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<SideTab>("clip");
  const [askTrack, setAskTrack] = useState<{ file: string; answer: (to: "voice" | "music" | null) => void } | null>(null);
  const peaksCache = useRef(new Map<string, PeaksFile>());

  const fps = timeline?.fps ?? DEFAULT_FPS;
  const placed = useMemo(() => (timeline ? layoutMain(timeline) : []), [timeline]);
  const duration = totalDuration(placed);
  const lastFrame = duration > 0 ? frameTime(Math.max(0, Math.ceil(duration * fps - 1e-6) - 1), fps) : 0;
  const voicePlaced = useMemo(() => (timeline ? layoutVoice(timeline) : []), [timeline]);
  const here = locate(placed, time);
  const hereVoice = locateVoice(voicePlaced, time);
  const selected = placed.find((p) => p.clip.id === selectedId) ?? null;
  const selectedMusic = timeline?.tracks.music?.find((m) => m.id === selectedId) ?? null;
  const selectedVoice = timeline?.tracks.voice?.find((m) => m.id === selectedId) ?? null;

  // Proxy and peaks URLs by source id, only changing when a URL actually changes.
  const urlsKey = JSON.stringify(Object.entries(server?.media ?? {}).map(([id, m]) => [id, m.proxy.url ?? null, m.peaks.url ?? null]));
  const urls = useMemo(() => {
    const out: Record<string, string | undefined> = {};
    for (const [id, proxy] of JSON.parse(urlsKey) as [string, string | null][]) out[id] = proxy ?? undefined;
    return out;
  }, [urlsKey]);

  useEffect(() => {
    const p = new SequencePlayer(videoA.current!, videoB.current!, stillImage.current!, { onTime: setTime, onRate: setRate });
    player.current = p;
    return () => {
      p.destroy();
      player.current = null;
    };
  }, []);

  const music = timeline?.tracks.music;
  const voice = timeline?.tracks.voice;
  const db = timeline ? duckDb(timeline) : 0;
  const stillsKey = timeline?.sources.filter((s) => isImage(s)).map((s) => s.id).join("\n") ?? "";
  const stills = useMemo(() => new Set(stillsKey ? stillsKey.split("\n") : []), [stillsKey]);
  useEffect(() => player.current?.setSequence(placed, urls, { music, voice, duckDb: db, stills }), [placed, urls, music, voice, db, stills]);
  const thumbnails = useMemo(() => Object.fromEntries([...stills].map((id) => [id, urls[id]])), [stills, urls]);

  // Load each source's waveform once it's ready.
  useEffect(() => {
    for (const [id, , url] of JSON.parse(urlsKey) as [string, string | null, string | null][]) {
      if (!url) continue;
      const cached = peaksCache.current.get(url);
      if (cached) {
        setPeaks((prev) => (prev[id] === cached ? prev : { ...prev, [id]: cached }));
        continue;
      }
      api.peaks(url).then(
        (data) => {
          peaksCache.current.set(url, data);
          setPeaks((prev) => ({ ...prev, [id]: data }));
        },
        () => {},
      );
    }
  }, [urlsKey]);

  // The transcript (one file for all sources) and whether transcription is installed.
  const transcriptUrl = Object.values(server?.media ?? {}).find((m) => m.transcript.url)?.transcript.url;
  useEffect(() => {
    if (!transcriptUrl) return setTranscript(null);
    api.transcript(transcriptUrl).then((r) => setTranscript(r.transcript), (err: Error) => setActionError(err.message));
  }, [transcriptUrl]);
  useEffect(() => {
    api.health().then((h) => setTranscriber(h.transcriber), () => {});
  }, []);

  // --- Actions -----------------------------------------------------------------

  const seek = (t: number) => player.current?.seek(Math.min(Math.max(0, t), lastFrame));
  const stepFrames = (n: number) => {
    player.current?.pause();
    seek(frameTime(frameAt(player.current?.currentTime ?? 0, fps) + n, fps));
  };
  const togglePlay = () => (rate !== 0 ? player.current?.pause() : player.current?.play(1));
  const shuttle = (direction: 1 | -1) => {
    const current = player.current?.playbackRate ?? 0;
    const next = Math.sign(current) === direction ? Math.max(-8, Math.min(8, current * 2)) : direction;
    player.current?.play(next);
  };

  const split = () => timeline && doc.applyEdit(splitAt(timeline, time));
  /**
   * Cuts the selected transcript words, plus the pause after them, from every clip that
   * plays them: main-track clips, or voiceover clips for a voiceover's transcript.
   */
  const cutWords = () => {
    if (!timeline || !wordSel) return;
    const source = timeline.sources.find((s) => s.id === wordSel.sourceId);
    const words = source && wordsFor(transcript, source.id, source.path);
    if (!source || !words) return;
    const first = Math.min(wordSel.anchor, wordSel.focus);
    const last = Math.max(wordSel.anchor, wordSel.focus);
    const to = words[last + 1]?.start ?? Math.min(words[last].end + 0.2, source.duration ?? Infinity);
    const cut = wordSel.track === "voice" ? cutVoiceSourceRange : cutSourceRange;
    doc.applyEdit(cut(timeline, source.id, words[first].start, to));
    setWordSel(null);
  };
  const remove = () => {
    if (!timeline) return;
    if (wordSel) cutWords();
    else if (marks.in !== null && marks.out !== null && marks.out > marks.in) {
      doc.applyEdit(cutRange(timeline, marks.in, marks.out));
      setMarks(NO_MARKS);
      seek(marks.in);
    } else if (selected) {
      doc.applyEdit(rippleDelete(timeline, selected.clip.id));
      setSelectedId(null);
    } else if (selectedVoice) {
      doc.applyEdit(removeAudio(timeline, "voice", selectedVoice.id));
      setSelectedId(null);
    } else if (selectedMusic) {
      doc.applyEdit(removeAudio(timeline, "music", selectedMusic.id));
      setSelectedId(null);
    }
  };
  const toggleMute = () => {
    const target = selected ?? here?.placed;
    if (timeline && target) doc.applyEdit(updateClip(timeline, target.clip.id, { muted: !target.clip.muted }));
  };
  const markIn = () => setMarks((m) => ({ in: time, out: m.out !== null && m.out > time ? m.out : null }));
  const markOut = () => setMarks((m) => ({ in: m.in !== null && m.in < time ? m.in : null, out: time }));

  // --- Keyboard ----------------------------------------------------------------

  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e: KeyboardEvent) => {
    const target = e.target instanceof Element ? e.target : document.body;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (mod && key === "z") {
      if (e.shiftKey) doc.redo();
      else doc.undo();
    } else if (mod && key === "y") doc.redo();
    else if (mod || e.altKey) return;
    // A focused button already responds to Space by itself.
    else if (key === " " && !target.closest("button")) togglePlay();
    else if (key === "j" && !e.repeat) shuttle(-1);
    else if (key === "k") player.current?.pause();
    else if (key === "l" && !e.repeat) shuttle(1);
    else if (key === "ArrowLeft") e.shiftKey ? seek(time - 1) : stepFrames(-1);
    else if (key === "ArrowRight") e.shiftKey ? seek(time + 1) : stepFrames(1);
    else if (key === "Home") seek(0);
    else if (key === "End") seek(lastFrame);
    else if (key === "s") split();
    else if (key === "Delete" || key === "Backspace") remove();
    else if (key === "m") toggleMute();
    else if (key === "i") markIn();
    else if (key === "o") markOut();
    else if (key === "Escape") {
      setMarks(NO_MARKS);
      setSelectedId(null);
      setWordSel(null);
    } else return;
    e.preventDefault();
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Clicking a word selects it and jumps to it; Shift+click extends the selection.
  const wordClick = useRef<(track: WordSelection["track"], sourceId: string, index: number, extend: boolean) => void>(() => {});
  wordClick.current = (track, sourceId, index, extend) => {
    setSelectedId(null);
    setWordSel((prev) =>
      extend && prev?.sourceId === sourceId && prev.track === track ? { ...prev, focus: index } : { track, sourceId, anchor: index, focus: index },
    );
    const source = timeline?.sources.find((s) => s.id === sourceId);
    const word = source ? wordsFor(transcript, sourceId, source.path)?.[index] : undefined;
    const at = word ? wordTimelineStart(track === "voice" ? voicePlaced : placed, sourceId, word) : null;
    if (!extend && at !== null) seek(at);
  };
  const onWordClick = useCallback(
    (track: WordSelection["track"], sourceId: string, index: number, extend: boolean) => wordClick.current(track, sourceId, index, extend),
    [],
  );

  function transcribe(sourceId: string) {
    setActionError(null);
    api.transcribe(name, sourceId).then(
      () => doc.refresh({ announce: false }),
      (err: Error) => setActionError(err.message),
    );
  }

  // --- Import --------------------------------------------------------------------

  /** Asks whether a sound file is a voiceover or music. Resolves null if cancelled. */
  function chooseTrack(file: string): Promise<"voice" | "music" | null> {
    return new Promise((resolve) => setAskTrack({ file, answer: resolve }));
  }

  async function importFiles(files: File[]) {
    setImportError(null);
    for (const file of files) {
      let to: "voice" | "music" | undefined;
      if (file.type.startsWith("audio/") || AUDIO_FILE.test(file.name)) {
        const answer = await chooseTrack(file.name);
        setAskTrack(null);
        if (!answer) continue;
        to = answer;
      }
      setUpload({ file: file.name, progress: 0 });
      setTab("media");
      try {
        await importFile(name, file, (progress) => setUpload({ file: file.name, progress }), to);
      } catch (err) {
        setImportError(`${file.name}: ${(err as Error).message}`);
        break;
      }
    }
    setUpload(null);
    await doc.refresh({ announce: false });
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length && !upload && !askTrack) void importFiles(files);
  }

  // --- Rendering -----------------------------------------------------------------

  /** Exports render what's in timeline.json, so wait until it's valid and saved. */
  function exportBlockedReason(): string | null {
    if (!timeline) return "Loading…";
    if (doc.errors.length) return "Fix the problems in timeline.json first.";
    if (!placed.length) return "Add a clip to the timeline first.";
    if (doc.saveState !== "saved") return "Waiting for your last change to be saved…";
    return null;
  }

  const currentMedia = here ? server?.media[here.placed.clip.sourceId] : undefined;
  const sourceFps = (here && timeline?.sources.find((s) => s.id === here.placed.clip.sourceId)?.fps) || fps;
  const resolution = timeline?.resolution;
  let overlay: string | null = null;
  if (!timeline) overlay = "Loading…";
  else if (!placed.length) overlay = "Drop a video or an image anywhere on this page, or use Import on the Media tab";
  else if (here && !urls[here.placed.clip.sourceId]) {
    const proxy = currentMedia?.proxy;
    overlay =
      proxy?.status === "running"
        ? `Preparing a smooth-playing copy (proxy)… ${Math.round(proxy.progress * 100)}%`
        : (proxy?.error ?? "Waiting to prepare the proxy…");
  }

  return (
    <main
      className={`page editor${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {doc.loadError && <div className="banner banner-error">{doc.loadError}</div>}
      {doc.errors.length > 0 && (
        <div className="banner banner-error">
          <strong>timeline.json has problems, so editing is paused.</strong>{" "}
          {timeline ? "The editor is showing the last valid version and won't change the file until it's fixed." : "There's no valid version to show yet."}{" "}
          Fix these in the file and the editor will pick up the change:
          <ul>
            {doc.errors.map((e, i) => (
              <li key={i}>
                <code>{e}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {doc.notice && (
        <div className="banner banner-info">
          {doc.notice}{" "}
          <button className="link" onClick={doc.dismissNotice}>
            Dismiss
          </button>
        </div>
      )}
      {doc.saveError && <div className="banner banner-error">{doc.saveError}</div>}
      {actionError && (
        <div className="banner banner-error">
          {actionError}{" "}
          <button className="link" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="editor-top">
        <section className="viewer">
          <div className="video-stage">
            <div className="video-box" style={videoBoxStyle(resolution)}>
              <video ref={videoA} />
              <video ref={videoB} />
              <img ref={stillImage} className="still-layer" alt="" />
              {overlay && <div className="video-overlay">{overlay}</div>}
            </div>
          </div>

          <div className="transport">
            <button title="Go to start (Home)" onClick={() => seek(0)}>
              ⏮
            </button>
            <button title="Back 1 second (Shift+←)" onClick={() => seek(time - 1)}>
              −1s
            </button>
            <button title="Back 1 frame (←)" onClick={() => stepFrames(-1)}>
              ◀︎|
            </button>
            <button className="play" title="Play / pause (Space). J/K/L: shuttle back / stop / forward" onClick={togglePlay} disabled={!placed.length}>
              {rate !== 0 ? "❚❚" : "▶︎"}
            </button>
            <button title="Forward 1 frame (→)" onClick={() => stepFrames(1)}>
              |▶︎
            </button>
            <button title="Forward 1 second (Shift+→)" onClick={() => seek(time + 1)}>
              +1s
            </button>
            <button title="Go to end (End)" onClick={() => seek(lastFrame)}>
              ⏭
            </button>
            {Math.abs(rate) > 1 || rate < 0 ? <span className="badge">{rate}×</span> : null}
            <div className="timecodes">
              <div className="timecode" title="Timeline time (HH:MM:SS:FF)">
                <span className="tc-label">TL</span> {formatTimecode(time, fps)}
                <span className="muted"> / {formatTimecode(duration, fps)}</span>
              </div>
              <div className="timecode small-tc" title="Source time of the clip under the playhead">
                <span className="tc-label">SRC</span> {here ? formatTimecode(here.sourceTime, sourceFps) : "--:--:--:--"}
                <span className="muted"> {here ? `${here.placed.clip.id} · ${here.placed.clip.sourceId}` : ""}</span>
              </div>
            </div>
          </div>

          <div className="edit-toolbar">
            <button onClick={split} disabled={!doc.canEdit} title="Split the clip at the playhead (S)">
              Split (S)
            </button>
            <button
              onClick={remove}
              disabled={!doc.canEdit || (!selected && !selectedMusic && !selectedVoice && !wordSel && (marks.in === null || marks.out === null))}
              title="Delete the marked range, or the selected clip (Delete)"
            >
              {marks.in !== null && marks.out !== null && marks.out > marks.in ? "Cut marked range (Del)" : "Delete clip (Del)"}
            </button>
            <button onClick={markIn} title="Mark the start of a range to cut (I)">
              Mark in (I)
            </button>
            <button onClick={markOut} title="Mark the end of a range to cut (O)">
              Mark out (O)
            </button>
            {(marks.in !== null || marks.out !== null) && (
              <button className="link" onClick={() => setMarks(NO_MARKS)} title="Clear marks (Esc)">
                Clear marks
              </button>
            )}
            <span className="spacer" />
            <button onClick={doc.undo} disabled={!doc.canUndo} title="Undo (Ctrl/Cmd+Z)">
              Undo
            </button>
            <button onClick={doc.redo} disabled={!doc.canRedo} title="Redo (Ctrl/Cmd+Shift+Z)">
              Redo
            </button>
            <span className={`save-state ${doc.saveState}`}>
              {doc.saveState === "saved" ? "Saved" : doc.saveState === "error" ? "Not saved" : "Saving…"}
            </span>
          </div>
        </section>

        <aside className="sidebar">
          <div className="tabs" role="tablist">
            {SIDE_TABS.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={`tab${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          <div className={`tab-body${tab === "transcript" ? " fill" : ""}`}>
            {tab === "transcript" && timeline && (
              <TranscriptPanel
                sources={timeline.sources}
                placed={placed}
                voicePlaced={voicePlaced}
                transcript={transcript}
                media={server?.media ?? {}}
                transcriber={transcriber}
                here={here ? { sourceId: here.placed.clip.sourceId, sourceTime: here.sourceTime } : null}
                hereVoice={hereVoice ? { sourceId: hereVoice.placed.clip.sourceId, sourceTime: hereVoice.sourceTime } : null}
                playing={rate !== 0}
                selection={wordSel}
                editable={doc.canEdit}
                onWordClick={onWordClick}
                onTranscribe={transcribe}
                onCutSelection={cutWords}
              />
            )}
            {tab === "clip" &&
              timeline &&
              (selectedVoice || selectedMusic ? (
                <AudioInspector
                  timeline={timeline}
                  track={selectedVoice ? "voice" : "music"}
                  clip={(selectedVoice ?? selectedMusic)!}
                  fps={fps}
                  editable={doc.canEdit}
                  onEdit={doc.applyEdit}
                  onDelete={remove}
                />
              ) : (
                <Inspector timeline={timeline} placed={selected} fps={fps} editable={doc.canEdit} onEdit={doc.applyEdit} onDelete={remove} />
              ))}
            {tab === "media" && (
              <MediaPanel
                sources={timeline?.sources ?? []}
                media={server?.media ?? {}}
                upload={upload}
                importError={importError}
                fps={fps}
                onImport={(files) => void importFiles(files)}
                onRetry={(id) => api.retry(name, id).then(() => doc.refresh(), (err: Error) => setImportError(err.message))}
                onDismissError={() => setImportError(null)}
              />
            )}
            {tab === "export" && <ExportPanel name={name} blockedReason={exportBlockedReason()} />}
          </div>
        </aside>
      </div>

      {timeline && (
        <TimelineView
          timeline={timeline}
          fps={fps}
          time={time}
          playing={rate !== 0}
          selectedId={selectedId}
          marks={marks}
          peaks={peaks}
          thumbnails={thumbnails}
          editable={doc.canEdit}
          onSeek={(t) => {
            player.current?.pause();
            seek(t);
          }}
          onSelect={(id) => {
            setSelectedId(id);
            if (id) {
              setWordSel(null);
              setTab("clip");
            }
          }}
          onEdit={(next) => doc.applyEdit(next)}
        />
      )}
      {doc.external && (
        <div className="toast" role="status">
          <div className="toast-head">
            <strong>Timeline updated externally</strong>
            <button className="link" onClick={doc.dismissExternal} title="Close">
              ✕
            </button>
          </div>
          <ul>
            {doc.external.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <div className="toast-actions">
            <span className="muted small">The previous version was saved in history/.</span>
            <button onClick={doc.undoExternal}>Undo</button>
          </div>
        </div>
      )}
      {dragging && <div className="drop-overlay">Drop to import into {name}</div>}
      {askTrack && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-label="Voiceover or music?">
            <h2>Voiceover or music?</h2>
            <p className="small">
              <strong>{askTrack.file}</strong> is a sound file. Voiceover goes on its own lane after any narration already there, at
              full volume, and can be transcribed. Music starts at the beginning of the timeline, at 30% volume.
            </p>
            <div className="modal-actions">
              <button className="link" onClick={() => askTrack.answer(null)}>
                Don't import
              </button>
              <button onClick={() => askTrack.answer("voice")}>Voiceover</button>
              <button className="primary" autoFocus onClick={() => askTrack.answer("music")}>
                Music
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/** Keeps the picture's shape and fits it inside the stage, however tall or wide that is. */
function videoBoxStyle(resolution: { width: number; height: number } | undefined) {
  const { width, height } = resolution ?? { width: 16, height: 9 };
  return { aspectRatio: `${width} / ${height}`, width: `min(100cqw, calc(100cqh * ${width} / ${height}))` };
}
