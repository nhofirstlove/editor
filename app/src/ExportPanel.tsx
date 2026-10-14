import { useCallback, useEffect, useState } from "react";
import type { ExportInfo } from "../../server/api-types.ts";
import { api } from "./api.ts";

const SHOWN = 8;

type Props = {
  name: string;
  /** Why exporting isn't possible right now, or null when it is. */
  blockedReason: string | null;
};

/** Starts exports and lists the ones in exports/, with progress while rendering. */
export function ExportPanel({ name, blockedReason }: Props) {
  const [exports, setExports] = useState<ExportInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setExports((await api.exports(name)).exports);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [name]);

  const busy = exports.some((e) => e.status === "queued" || e.status === "running");
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), busy ? 1000 : 10_000);
    return () => clearInterval(timer);
  }, [load, busy]);

  async function handoff() {
    setError(null);
    try {
      await api.handoff(name);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function start(preset: "final" | "preview") {
    setError(null);
    try {
      await api.startExport(name, preset);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Export</h2>
      </div>
      <div className="row export-buttons">
        <button onClick={() => void start("final")} disabled={!!blockedReason} title="Full resolution, high quality H.264 + AAC">
          Final
        </button>
        <button onClick={() => void start("preview")} disabled={!!blockedReason} title="720p, fast to make, smaller file">
          Quick preview
        </button>
        <button
          onClick={() => void handoff()}
          disabled={!!blockedReason}
          title="An OpenTimelineIO (.otio) file of the edit, to open in DaVinci Resolve for colour, mixing and finishing"
        >
          For DaVinci Resolve
        </button>
      </div>
      {blockedReason && <p className="muted small">{blockedReason}</p>}
      {error && (
        <div className="banner banner-error small">
          {error}
          <button className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      <ul className="exports">
        {exports.slice(0, SHOWN).map((e) => (
          <li key={e.name} className="export">
            <div className="small export-name" title={e.name}>
              {e.preset === "final" ? "Final" : e.preset === "preview" ? "Preview" : e.preset === "resolve" ? "DaVinci Resolve (.otio)" : "Export"} ·{" "}
              {new Date(e.createdAt).toLocaleString()}
            </div>
            {e.status === "running" && (
              <div className="job">
                <div className="small">Rendering {Math.round(e.progress * 100)}%</div>
                <div className="progress">
                  <div style={{ width: `${Math.round(e.progress * 100)}%` }} />
                </div>
              </div>
            )}
            {e.status === "queued" && <div className="small muted">Waiting for other work to finish…</div>}
            {e.status === "failed" && <div className="small error-text">{e.error}</div>}
            <div className="small">
              {e.url && e.preset === "resolve" && (
                <a href={e.url} download>
                  Download
                </a>
              )}
              {e.url && e.preset !== "resolve" && (
                <a href={e.url} target="_blank" rel="noreferrer">
                  Play
                </a>
              )}
              {e.url && e.commandUrl && " · "}
              {e.commandUrl && (
                <a href={e.commandUrl} target="_blank" rel="noreferrer">
                  ffmpeg command
                </a>
              )}
              {e.duration !== undefined && <span className="muted"> · {e.duration.toFixed(2)} s</span>}
              {e.size !== undefined && <span className="muted"> · {(e.size / 1024 / 1024).toFixed(1)} MB</span>}
            </div>
          </li>
        ))}
      </ul>
      {exports.length > SHOWN && <p className="muted small">…and {exports.length - SHOWN} older exports in the exports/ folder.</p>}
      {exports.length === 0 && <p className="muted small">Exports are saved in the project's exports/ folder.</p>}
    </div>
  );
}
