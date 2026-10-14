// Whether real transcription tests can run here without downloading anything:
// Python with faster-whisper, and its small "base" model already downloaded.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const hfHub = path.join(process.env.HF_HOME ?? path.join(homedir(), ".cache", "huggingface"), "hub");

export const canTranscribe =
  spawnSync(python, ["-c", "import faster_whisper"]).status === 0 && existsSync(path.join(hfHub, "models--Systran--faster-whisper-base"));

/** Windows text-to-speech: "Hello and welcome to the studio. Today we are talking about video editing. …" */
export const speechSample = fileURLToPath(new URL("../fixtures/speech.wav", import.meta.url));
