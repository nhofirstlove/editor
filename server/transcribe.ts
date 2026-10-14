// Transcription with faster-whisper (Python). ffmpeg first extracts the audio as 16 kHz
// mono WAV, the same way exports read the media, so word times line up with source time.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Source } from "../schema/timeline.ts";
import { parseTranscriptJson, type SourceTranscript, type Transcript, type Word } from "../schema/transcript.ts";
import { runFfmpeg, type ToolStatus } from "./ffmpeg.ts";
import { withLock } from "./projects.ts";

const SCRIPT = fileURLToPath(new URL("./transcribe.py", import.meta.url));
/** Which faster-whisper model to use: tiny, base, small, medium, large-v3… Bigger is better and slower. */
export const WHISPER_MODEL = process.env.WHISPER_MODEL || "small";
/** Language code like "en", or empty to detect it. */
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || "";
const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");

const INSTALL_HELP =
  "Transcription needs Python 3 with faster-whisper. Install Python from python.org, then run " +
  "`pip install faster-whisper` in a terminal, and restart the editor. The README has details.";

let checked: Promise<ToolStatus> | null = null;

/** Checks once whether Python and faster-whisper are available. */
export function checkTranscriber(): Promise<ToolStatus> {
  checked ??= new Promise((resolve) => {
    const child = spawn(PYTHON, ["-c", "import faster_whisper"], { stdio: "ignore" });
    child.on("error", () => resolve({ ok: false, message: INSTALL_HELP }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, message: INSTALL_HELP }));
  });
  return checked;
}

type ScriptResult = { language: string; device: string; words: Word[] };

/** Runs transcribe.py on an audio file. Progress is 0..1; notes are messages worth showing. */
function runScript(audio: string, output: string, model: string, onProgress: (p: number) => void, onNote: (text: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-u", SCRIPT, audio, output, model, WHISPER_LANGUAGE], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let buffered = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("PROGRESS ")) onProgress(Number(line.slice(9)) || 0);
        else if (line.startsWith("NOTE ")) onNote(line.slice(5));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr = (stderr + c).slice(-3000)));
    child.on("error", () => reject(new Error(INSTALL_HELP)));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      if (code === 3) return reject(new Error(INSTALL_HELP));
      const lastLine = stderr.trim().split(/\r?\n/).filter((l) => !l.includes("[warning]")).pop() ?? "no details";
      reject(new Error(`Transcription failed: ${lastLine}`));
    });
  });
}

/**
 * Transcribes a source and stores its words in the project's transcript.json, replacing
 * any earlier transcript of that source.
 */
export async function transcribeSource(
  projectDir: string,
  source: Source,
  onProgress: (p: number) => void,
  onNote: (text: string) => void = () => {},
  model = WHISPER_MODEL,
): Promise<void> {
  const work = await mkdtemp(path.join(tmpdir(), "tve-transcribe-"));
  try {
    const audio = path.join(work, "audio.wav");
    // Extracting the audio is quick; count it as the first 5%.
    await runFfmpeg(
      ["-i", path.join(projectDir, source.path), "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audio],
      source.duration ?? 0,
      (p) => onProgress(p * 0.05),
    ).catch((err: Error) => {
      throw /matches no streams/.test(err.message) ? new Error("This file has no audio track, so there is nothing to transcribe.") : err;
    });
    const output = path.join(work, "words.json");
    await runScript(audio, output, model, (p) => onProgress(0.05 + p * 0.95), onNote);
    const result = JSON.parse(await readFile(output, "utf8")) as ScriptResult;
    await saveSourceTranscript(projectDir, source.id, {
      path: source.path,
      model,
      language: result.language,
      createdAt: new Date().toISOString(),
      words: result.words,
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const cache = new Map<string, { mtimeMs: number; result: TranscriptFile }>();

export type TranscriptFile = { transcript: Transcript | null; error: string | null; mtimeMs: number | null };

/** Reads transcript.json. A missing file is an empty transcript; a broken one is reported, never thrown. */
export async function readTranscript(projectDir: string): Promise<TranscriptFile> {
  const file = path.join(projectDir, "transcript.json");
  const info = await stat(file).catch(() => null);
  if (!info) return { transcript: null, error: null, mtimeMs: null };
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === info.mtimeMs) return hit.result;
  const parsed = parseTranscriptJson(await readFile(file, "utf8"));
  const result: TranscriptFile = parsed.ok
    ? { transcript: parsed.transcript, error: null, mtimeMs: info.mtimeMs }
    : { transcript: null, error: `${parsed.error} Transcribe again to rebuild it.`, mtimeMs: info.mtimeMs };
  cache.set(file, { mtimeMs: info.mtimeMs, result });
  return result;
}

async function saveSourceTranscript(projectDir: string, sourceId: string, entry: SourceTranscript): Promise<void> {
  await withLock(`transcript:${projectDir}`, async () => {
    const current = await readTranscript(projectDir);
    // A broken transcript.json is replaced rather than merged into.
    const transcript: Transcript = { version: 1, sources: { ...(current.transcript?.sources ?? {}), [sourceId]: entry } };
    const file = path.join(projectDir, "transcript.json");
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, formatTranscript(transcript));
    await rename(tmp, file);
  });
}

/** Pretty JSON with one word per line, so the file is easy to read and search. */
export function formatTranscript(t: Transcript): string {
  const sources = Object.entries(t.sources ?? {});
  const lines = ["{", `  "version": 1,`, `  "sources": {`];
  sources.forEach(([id, s], i) => {
    const { words, ...info } = s;
    lines.push(`    ${JSON.stringify(id)}: {`);
    for (const [key, value] of Object.entries(info)) lines.push(`      ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
    lines.push(`      "words": [`);
    words.forEach((w, j) => lines.push(`        ${JSON.stringify(w)}${j < words.length - 1 ? "," : ""}`));
    lines.push("      ]", `    }${i < sources.length - 1 ? "," : ""}`);
  });
  lines.push("  }", "}", "");
  return lines.join("\n");
}
