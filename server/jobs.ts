// A simple background job queue. Jobs run one at a time so a big proxy encode doesn't
// starve the machine. State lives in memory; generated files on disk are the record of
// what's finished, so a restart just regenerates anything that's missing.

export type JobState = {
  status: "queued" | "running" | "done" | "failed";
  /** 0..1 */
  progress: number;
  error?: string;
  /** A message from the running job worth showing, e.g. "using the processor instead". */
  note?: string;
};

type Job = { key: string; run: (onProgress: (p: number) => void, onNote: (text: string) => void) => Promise<void> };

const states = new Map<string, JobState>();
const queue: Job[] = [];
let running = false;

/** Adds a job unless one with the same key is already queued, running, or failed. */
export function enqueue(key: string, run: Job["run"]): void {
  const existing = states.get(key);
  if (existing && existing.status !== "done") return;
  states.set(key, { status: "queued", progress: 0 });
  queue.push({ key, run });
  void pump();
}

export function jobState(key: string): JobState | undefined {
  return states.get(key);
}

/** Forgets a failed job so the next request can queue it again. */
export function clearFailed(key: string): void {
  if (states.get(key)?.status === "failed") states.delete(key);
}

/** Resolves when the queue is empty. Used by tests. */
export async function idle(): Promise<void> {
  while (running || queue.length) await new Promise((r) => setTimeout(r, 50));
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const state = states.get(job.key)!;
      state.status = "running";
      try {
        await job.run(
          (p) => (state.progress = p),
          (text) => (state.note = text),
        );
        state.status = "done";
        state.progress = 1;
      } catch (err) {
        state.status = "failed";
        state.error = (err as Error).message;
      }
    }
  } finally {
    running = false;
  }
}
