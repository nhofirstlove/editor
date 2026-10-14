import { useRef } from "react";
import { isImage, type Source } from "../../schema/timeline.ts";
import type { FileStatus, MediaStatus } from "../../server/api-types.ts";
import { formatTimecode } from "../../schema/timecode.ts";

type Props = {
  sources: Source[];
  media: Record<string, MediaStatus>;
  upload: { file: string; progress: number } | null;
  importError: string | null;
  fps: number;
  onImport: (files: File[]) => void;
  onRetry: (sourceId: string) => void;
  onDismissError: () => void;
};

/** Imported files, with proxy and waveform progress, and the Import button. */
export function MediaPanel(props: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Media</h2>
        <button onClick={() => fileInput.current?.click()} disabled={!!props.upload}>
          Import video, audio or images…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="video/*,audio/*,image/png,image/jpeg,image/webp,image/bmp,image/tiff,.mov,.mkv,.mxf,.avi,.mts"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) props.onImport(files);
          }}
        />
      </div>
      {props.upload && (
        <div className="job">
          <div className="small">Copying {props.upload.file} into the project…</div>
          <Progress value={props.upload.progress} />
        </div>
      )}
      {props.importError && (
        <div className="banner banner-error small">
          {props.importError}
          <button className="link" onClick={props.onDismissError}>
            Dismiss
          </button>
        </div>
      )}
      {props.sources.length === 0 && !props.upload && (
        <p className="muted small">No media yet. Drop a video, an audio file or an image (PNG, JPEG) anywhere on the page. Imported files are copied into media/; images go on the main track for 3 seconds, and for audio you choose voiceover or music.</p>
      )}
      <ul className="sources">
        {props.sources.map((s) => {
          const status = props.media[s.id];
          const failed = status && (status.proxy.status === "failed" || status.peaks.status === "failed");
          return (
            <li key={s.id} className="source">
              <div className="source-name">{s.path.replace(/^media\//, "")}</div>
              {isImage(s) ? (
                <div className="muted small">
                  {s.id} · still image{s.width && s.height ? ` · ${s.width}×${s.height}` : ""}
                </div>
              ) : (
                <div className="muted small">
                  {s.id} · {s.duration !== undefined ? formatTimecode(s.duration, s.fps ?? props.fps) : "length unknown"}
                  {s.width && s.height ? ` · ${s.width}×${s.height}` : ""}
                  {s.fps ? ` · ${s.fps} fps` : ""} · {describeChannels(s.audioChannels)}
                </div>
              )}
              {status && <JobLine label={isImage(s) ? "Preview copy" : "Proxy"} status={status.proxy} />}
              {status && !isImage(s) && <JobLine label="Waveform" status={status.peaks} />}
              {failed && (
                <button className="link" onClick={() => props.onRetry(s.id)}>
                  Try again
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function JobLine({ label, status }: { label: string; status: FileStatus }) {
  switch (status.status) {
    case "ready":
      return <div className="small ok">{label} ready</div>;
    case "no-audio":
      return <div className="small muted">{label}: no audio track</div>;
    case "queued":
      return <div className="small muted">{label}: waiting…</div>;
    case "running":
      return (
        <div className="job">
          <div className="small">
            {label}: preparing {Math.round(status.progress * 100)}%
          </div>
          <Progress value={status.progress} />
        </div>
      );
    default:
      return (
        <div className="small error-text">
          {label} failed: {status.error}
        </div>
      );
  }
}

function Progress({ value }: { value: number }) {
  return (
    <div className="progress">
      <div style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

function describeChannels(n: number | undefined): string {
  if (n === undefined) return "audio unknown";
  if (n === 0) return "no audio";
  if (n === 1) return "mono";
  if (n === 2) return "stereo";
  return `${n} audio channels`;
}
