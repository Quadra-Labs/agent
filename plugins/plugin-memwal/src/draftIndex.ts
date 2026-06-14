// draftIndex.ts — SQLite-backed JOB-DRAFT index: resolves (agent, room) -> latest job-draft
// blobId, newest-first, on the runtime's local DB. A sibling of MenuIndex/CheckpointIndex but
// COLLISION-FREE: a DISTINCT table ("memwal_drafts") and a DISTINCT namespace literal
// ("memwal-draft:", not "memwal:" / "memwal-menu:"), keyed by the (agent, room) PAIR (a draft
// is per live conversation). Length-prefixed for injectivity, same as the other indexes. A
// private collaborator MemwalService owns.

import { stringToUuid, ChannelType } from "@elizaos/core";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";

// Dedicated table for draft records — never the checkpoint or menu table.
const DRAFT_TABLE = "memwal_drafts";

/** A resolved draft-index record. Local to the index; does NOT touch the result unions. */
export interface DraftIndexRecord {
  readonly blobId: string;
  readonly agent: string;
  readonly room: string;
  readonly createdAt: number;
}

export interface DraftIndexEntryInput {
  readonly agent: string;
  readonly room: string;
  readonly blobId: string;
}

// Per-namespace monotonic clock so back-to-back writes order deterministically (mirrors the
// menu index). Keyed by the derived draft namespace; disjoint from the menu/checkpoint clocks.
const lastStamp = new Map<string, number>();

function nextCreatedAt(namespace: string): number {
  const now = Date.now();
  const prev = lastStamp.get(namespace) ?? 0;
  const stamp = now > prev ? now : prev + 1;
  lastStamp.set(namespace, stamp);
  return stamp;
}

// Derive the stable namespace roomId for an (agent, room) pair. The "memwal-draft:" literal +
// length prefixes on BOTH components make this injective and disjoint from the menu
// ("memwal-menu:") and checkpoint ("memwal:") namespaces for ANY strings, so a draft can never
// land in (or be read from) another bucket.
function draftNamespaceFor(agent: string, room: string): UUID {
  return stringToUuid(`memwal-draft:${agent.length}:${agent}:${room.length}:${room}`);
}

function entityIdFor(runtime: IAgentRuntime): UUID {
  return runtime.agentId;
}

async function ensureNamespace(
  runtime: IAgentRuntime,
  roomId: UUID,
  entityId: UUID,
): Promise<void> {
  const worldId = stringToUuid(`memwal-draft-world:${roomId}`);
  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    name: "memwal-draft-index",
    source: "memwal",
    type: ChannelType.DM,
  });
}

/**
 * SQLite-backed draft index. A private collaborator MemwalService holds; it exposes a single
 * WRITE entry (record) the service calls on its own ok:true writeDraft path plus READ
 * resolvers. Persistence is the runtime's local DB, so a fresh instance against the SAME DB
 * sees prior records (restart survival).
 */
export class DraftIndex {
  private readonly runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  /** Persist one draft-index entry for a successful draft write. Returns the new record id. */
  async record(entry: DraftIndexEntryInput): Promise<UUID> {
    const roomId = draftNamespaceFor(entry.agent, entry.room);
    const entityId = entityIdFor(this.runtime);
    await ensureNamespace(this.runtime, roomId, entityId);

    const createdAt = nextCreatedAt(roomId);
    const memory: Memory = {
      entityId,
      agentId: this.runtime.agentId,
      roomId,
      createdAt,
      content: {
        memwalDraftBlobId: entry.blobId,
        memwalDraftAgent: entry.agent,
        memwalDraftRoom: entry.room,
        memwalDraftCreatedAt: createdAt,
        // A non-empty text keeps parity with how memories are stored; not load-bearing.
        text: `draft:${entry.agent}:${entry.room}`,
        source: "memwal-draft",
      },
    };
    return this.runtime.createMemory(memory, DRAFT_TABLE);
  }

  /** Full draft records for an (agent, room) pair, NEWEST-first. Unknown pair -> empty array. */
  async list(agent: string, room: string): Promise<readonly DraftIndexRecord[]> {
    const roomId = draftNamespaceFor(agent, room);
    const memories = await this.runtime.getMemories({
      roomId,
      tableName: DRAFT_TABLE,
      count: 1000,
    });
    const records = memories
      .map((memory) => toRecord(memory))
      .filter((record): record is DraftIndexRecord => record !== undefined);
    return [...records].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The newest full record for an (agent, room) pair, or undefined. */
  async latestRecord(agent: string, room: string): Promise<DraftIndexRecord | undefined> {
    return (await this.list(agent, room))[0];
  }

  /** The newest draft blobId for an (agent, room) pair, or undefined. */
  async latest(agent: string, room: string): Promise<string | undefined> {
    return (await this.latestRecord(agent, room))?.blobId;
  }
}

function toRecord(memory: Memory): DraftIndexRecord | undefined {
  const content = memory.content ?? {};
  const blobId = content.memwalDraftBlobId;
  if (typeof blobId !== "string") return undefined;
  const agent = typeof content.memwalDraftAgent === "string" ? content.memwalDraftAgent : "";
  const room = typeof content.memwalDraftRoom === "string" ? content.memwalDraftRoom : "";
  const createdAt =
    typeof content.memwalDraftCreatedAt === "number"
      ? content.memwalDraftCreatedAt
      : memory.createdAt ?? 0;
  return { blobId, agent, room, createdAt };
}
