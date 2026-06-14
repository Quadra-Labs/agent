// jobDraft.ts — the app's thin accessor for the in-conversation MemWal job-draft (the agent's
// "knowledge pool" for one job in flight). Mirrors menuOrchestrator.ts: the MemWal slice is
// resolved structurally from getService("memwal") (the app depends on the runtime contract,
// not the plugin class), and the draft result TYPES are imported from the plugin directly.
// Both calls NEVER throw — the service methods already never throw, and a missing service folds
// to a soft no-op so a plain chat session is unaffected.

import type { IAgentRuntime } from "@elizaos/core";

import type {
  JobDraftRecord,
  ReadDraftResult,
  WriteDraftResult,
} from "../../../plugins/plugin-memwal/src/draftTypes.js";

// The MemWal draft slice this module drives — the two methods the service exposes.
type MemwalDraftStore = {
  writeDraft(draft: JobDraftRecord): Promise<WriteDraftResult>;
  readLatestDraft(agent: string, room: string): Promise<ReadDraftResult>;
};

function resolveDraftStore(runtime: IAgentRuntime): MemwalDraftStore | undefined {
  const svc = runtime.getService("memwal");
  if (svc === undefined || svc === null) return undefined;
  return svc as unknown as MemwalDraftStore;
}

export interface SaveDraftInput {
  readonly runtime: IAgentRuntime;
  readonly agent: string;
  readonly room: string;
  /** The draft body; (agent, room, createdAt) are stamped here. */
  readonly draft: Omit<JobDraftRecord, "agent" | "room" | "createdAt">;
  readonly now?: () => number;
}

export type SaveDraftOutcome = WriteDraftResult | { ok: false; kind: "no_store" };

/** Persist the latest job-draft revision for (agent, room). Soft no_store when MemWal is
 * absent (e.g. a runtime without the plugin). NEVER throws. */
export async function saveJobDraft(input: SaveDraftInput): Promise<SaveDraftOutcome> {
  const store = resolveDraftStore(input.runtime);
  if (store === undefined) return { ok: false, kind: "no_store" };
  const record: JobDraftRecord = {
    agent: input.agent,
    room: input.room,
    createdAt: (input.now ?? Date.now)(),
    ...input.draft,
  };
  return store.writeDraft(record);
}

export interface LoadDraftInput {
  readonly runtime: IAgentRuntime;
  readonly agent: string;
  readonly room: string;
}

/** The latest job-draft for (agent, room), or undefined when none exists / MemWal is absent /
 * the blob is unreadable. NEVER throws. */
export async function loadJobDraft(input: LoadDraftInput): Promise<JobDraftRecord | undefined> {
  const store = resolveDraftStore(input.runtime);
  if (store === undefined) return undefined;
  const result = await store.readLatestDraft(input.agent, input.room);
  return result.ok ? result.draft : undefined;
}
