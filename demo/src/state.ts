// Tiny JSON persistence for the demo, at demo/demo-state.json (gitignored). It
// remembers the templates blobId (so we do not re-seed Walrus on every run) and a
// list of checkpoints written to MemWal (so /resume and /sessions work across
// process restarts). Pure file I/O -- no network, no runtime dependency.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
// demo/demo-state.json lives one level up from src/.
const STATE_PATH = resolve(here, "..", "demo-state.json");

/** One recorded checkpoint pointer (the blob lives on Walrus; this is the index). */
export interface CheckpointRecord {
  readonly blobId: string;
  readonly roomId: string;
  readonly createdAt: number;
  /** Short human preview of the summary (for /sessions and /resume). */
  readonly preview: string;
}

export interface DemoState {
  /** Cached templates blobId; absent until first seed. */
  readonly templatesBlobId?: string;
  /** All checkpoints written this and prior runs, oldest-first by insertion. */
  readonly checkpoints: readonly CheckpointRecord[];
}

const EMPTY_STATE: DemoState = { checkpoints: [] };

/**
 * Load the demo state from disk. A missing or unreadable/invalid file yields a
 * fresh empty state rather than throwing, so the demo always starts cleanly.
 */
export async function loadState(): Promise<DemoState> {
  let raw: string;
  try {
    raw = await readFile(STATE_PATH, "utf8");
  } catch {
    return EMPTY_STATE;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DemoState>;
    const checkpoints = Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [];
    return {
      templatesBlobId:
        typeof parsed.templatesBlobId === "string" ? parsed.templatesBlobId : undefined,
      checkpoints,
    };
  } catch {
    return EMPTY_STATE;
  }
}

/** Persist the demo state to disk (pretty-printed for easy human inspection). */
export async function saveState(state: DemoState): Promise<void> {
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Append a checkpoint record and persist. Returns the new state (immutably built
 * from the prior one). Convenience around loadState/saveState.
 */
export async function recordCheckpoint(record: CheckpointRecord): Promise<DemoState> {
  const current = await loadState();
  const next: DemoState = {
    ...current,
    checkpoints: [...current.checkpoints, record],
  };
  await saveState(next);
  return next;
}

/** The most recently recorded checkpoint, or undefined if none exist yet. */
export async function latestCheckpoint(): Promise<CheckpointRecord | undefined> {
  const { checkpoints } = await loadState();
  return checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : undefined;
}
