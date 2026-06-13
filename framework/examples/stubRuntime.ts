// stubRuntime.ts — SANDBOX SUPPORT: the one keyless in-memory stub runtime behind
// `chat.ts --sandbox`. Lets the examples exercise the rails (MCP tool server, turn
// persistence, the /close checkpoint rail) offline with a canned model and no API keys.
// Not part of the framework API: it lives under examples/ and is imported only by chat.ts.

import { stringToUuid } from "@elizaos/core";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";

import type {
  Checkpoint,
  ReadCheckpointResult,
  WriteCheckpointResult,
} from "../../plugins/plugin-memwal/src/types.js";

/** A stub model: prompt in, reply out. */
export type StubModel = (prompt: string) => string | Promise<string>;

/** Always reply with the same text. */
export function cannedModel(text: string): StubModel {
  return () => text;
}

/** Pop a queue of emissions (strings or prompt-aware functions). Exhausted -> the
 *  `tail` reply when set, else a throw (an unscripted call is a test failure). */
export function scriptedModel(
  entries: ReadonlyArray<string | ((prompt: string) => string)>,
  options?: { readonly tail?: string },
): StubModel {
  const queue = [...entries];
  return (prompt: string) => {
    const entry = queue.shift();
    if (entry === undefined) {
      if (options?.tail !== undefined) return options.tail;
      throw new Error("scriptedModel exhausted: unexpected extra model call");
    }
    return typeof entry === "function" ? entry(prompt) : entry;
  };
}

/** A shared checkpoint cell: lets two stub runtimes from the same test see each
 *  other's writes (a real restart-recall round-trip). */
export interface CheckpointCell {
  checkpoint?: Checkpoint;
  blobId?: string;
}
export function makeCheckpointCell(): CheckpointCell {
  return {};
}

export interface StubMemwalOptions {
  /** Always-recalled: latest() resolves a blob and readCheckpoint() returns a prior
   *  checkpoint carrying this summary. */
  readonly recalledSummary?: string;
  /** Restart-aware: writes land in the cell; latest()/readCheckpoint() resolve from
   *  it, so a later session recalls what an earlier one wrote. */
  readonly cell?: CheckpointCell;
}

export interface StubRuntimeOptions {
  /** agentId seed (distinct ids isolate parallel stubs). */
  readonly id?: string;
  /** The model behind useModel. Default: cannedModel("ack"). */
  readonly model?: StubModel;
  readonly memwal?: StubMemwalOptions;
  /** Add an in-memory walrus store/read round-trip (the template-rail variant). */
  readonly walrusBlobs?: boolean;
}

export interface StubRuntimeHandle {
  readonly runtime: IAgentRuntime;
  /** Memories keyed by `${roomId}::${tableName}`. */
  readonly store: Map<string, Memory[]>;
  /** Every checkpoint passed to writeCheckpoint, in order. */
  readonly writeCalls: Checkpoint[];
  /** Every prompt passed to useModel, in order. */
  readonly prompts: string[];
  /** The stored message texts for a room (the assertion most tests repeat). */
  storedTexts(roomId: string): string[];
}

/** Build a keyless stub runtime. Defaults: canned "ack" model, no prior checkpoint,
 *  writeCheckpoint -> { ok, indexed: true }, no walrus. */
export function makeStubRuntime(options?: StubRuntimeOptions): StubRuntimeHandle {
  const agentId = stringToUuid(options?.id ?? "stub-runtime");
  const store = new Map<string, Memory[]>();
  const writeCalls: Checkpoint[] = [];
  const prompts: string[] = [];
  const model = options?.model ?? cannedModel("ack");
  const cell = options?.memwal?.cell;
  const recalledSummary = options?.memwal?.recalledSummary;
  const keyOf = (roomId: UUID, tableName: string): string => `${roomId}::${tableName}`;

  const memwal = {
    latest: async (): Promise<string | undefined> => {
      if (recalledSummary !== undefined) return "blob-recalled";
      return cell?.blobId;
    },
    readCheckpoint: async (blobId: string): Promise<ReadCheckpointResult> => {
      if (recalledSummary !== undefined) {
        return {
          ok: true,
          checkpoint: {
            roomId: "prior-room",
            createdAt: 1,
            turnCount: 2,
            summary: recalledSummary,
            user: "alice",
            agent: "PriorAgent",
            session: "prior-session",
          },
        };
      }
      if (cell?.checkpoint !== undefined) {
        return { ok: true, checkpoint: cell.checkpoint };
      }
      return {
        ok: false,
        kind: "invalid_checkpoint",
        blobId,
        errorName: "NoCheckpoint",
        message: "no checkpoint written yet",
        retryable: false,
      };
    },
    writeCheckpoint: async (cp: Checkpoint): Promise<WriteCheckpointResult> => {
      writeCalls.push(cp);
      if (cell !== undefined) {
        cell.checkpoint = cp;
        cell.blobId = "blob-from-write";
      }
      return { ok: true, blobId: cell?.blobId ?? "cp", indexed: true };
    },
  };

  // In-memory walrus store/read round-trip, structurally compatible with the rail's
  // WalrusLike usage (seedTemplates/loadTemplates).
  const blobs = new Map<string, Uint8Array>();
  let nextBlob = 0;
  const walrus = {
    store: async (bytes: Uint8Array) => {
      const blobId = `templates-blob-${nextBlob++}`;
      blobs.set(blobId, bytes);
      return { ok: true as const, blobId, sizeBytes: bytes.byteLength };
    },
    read: async (blobId: string) => {
      const bytes = blobs.get(blobId);
      if (bytes === undefined) {
        return {
          ok: false as const,
          kind: "blob_unavailable" as const,
          blobId,
          errorName: "NotFound",
          message: "no such blob",
          retryable: false,
        };
      }
      return { ok: true as const, bytes, blobId };
    },
  };

  const runtime = {
    agentId,
    ensureConnection: async (): Promise<void> => {},
    createMemory: async (memory: Memory, tableName: string): Promise<UUID> => {
      const roomId = memory.roomId as UUID;
      const key = keyOf(roomId, tableName);
      const existing = store.get(key) ?? [];
      store.set(key, [...existing, memory]);
      return stringToUuid(`mem:${key}:${existing.length}`);
    },
    // Newest-first, mirroring the real DESC ordering (listTurns re-sorts oldest-first).
    getMemories: async (params: { roomId: UUID; tableName: string }): Promise<Memory[]> =>
      [...(store.get(keyOf(params.roomId, params.tableName)) ?? [])].reverse(),
    useModel: async (_type: unknown, params: { prompt: string }): Promise<string> => {
      prompts.push(params.prompt);
      return model(params.prompt);
    },
    getService: (name: string): unknown => {
      if (name === "memwal") return memwal;
      if (name === "walrus" && options?.walrusBlobs === true) return walrus;
      return undefined;
    },
  };

  return {
    runtime: runtime as unknown as IAgentRuntime,
    store,
    writeCalls,
    prompts,
    storedTexts(roomId: string): string[] {
      return (store.get(`${stringToUuid(roomId)}::messages`) ?? []).map((m) =>
        typeof m.content?.text === "string" ? m.content.text : "",
      );
    },
  };
}
