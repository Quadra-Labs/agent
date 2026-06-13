// menuIndex.ts — SQLite-backed MENU index: resolves agent -> latest menu blobId (+ its
// sourceHash for cheap staleness checks), newest-first, on the runtime's local DB. A sibling
// of CheckpointIndex but COLLISION-FREE: a DISTINCT table ("memwal_menus", not
// "memwal_checkpoints") and a DISTINCT namespace literal ("memwal-menu:", not "memwal:"),
// keyed by AGENT ONLY (a menu is per-agent, not per (user,agent)). Length-prefixed for
// injectivity, same as the checkpoint index. A private collaborator MemwalService owns.

import { stringToUuid, ChannelType } from "@elizaos/core";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";

// Dedicated table for menu records — never the checkpoint table.
const MENU_TABLE = "memwal_menus";

/** A resolved menu-index record. Local to the index; does NOT touch the locked result unions. */
export interface MenuIndexRecord {
  readonly blobId: string;
  readonly agent: string;
  readonly sourceHash: string;
  readonly createdAt: number;
}

export interface MenuIndexEntryInput {
  readonly agent: string;
  readonly blobId: string;
  readonly sourceHash: string;
}

// Per-namespace monotonic clock so back-to-back writes order deterministically (mirrors the
// checkpoint index). Keyed by the derived menu namespace; disjoint from the checkpoint clock.
const lastStamp = new Map<string, number>();

function nextCreatedAt(namespace: string): number {
  const now = Date.now();
  const prev = lastStamp.get(namespace) ?? 0;
  const stamp = now > prev ? now : prev + 1;
  lastStamp.set(namespace, stamp);
  return stamp;
}

// Derive the stable namespace roomId for an agent. The "memwal-menu:" literal + length
// prefix make this disjoint from the checkpoint index's "memwal:" namespace for ANY string,
// so a menu can never land in (or be read from) a checkpoint bucket and vice-versa.
function menuNamespaceFor(agent: string): UUID {
  return stringToUuid(`memwal-menu:${agent.length}:${agent}`);
}

function entityIdFor(runtime: IAgentRuntime): UUID {
  return runtime.agentId;
}

async function ensureNamespace(
  runtime: IAgentRuntime,
  roomId: UUID,
  entityId: UUID,
): Promise<void> {
  const worldId = stringToUuid(`memwal-menu-world:${roomId}`);
  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    name: "memwal-menu-index",
    source: "memwal",
    type: ChannelType.DM,
  });
}

/**
 * SQLite-backed menu index. A private collaborator MemwalService holds; it exposes a single
 * WRITE entry (record) the service calls on its own ok:true writeMenu path plus READ
 * resolvers. Persistence is the runtime's local DB, so a fresh instance against the SAME DB
 * sees prior records (restart survival).
 */
export class MenuIndex {
  private readonly runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  /** Persist one menu-index entry for a successful menu write. Returns the new record id. */
  async record(entry: MenuIndexEntryInput): Promise<UUID> {
    const roomId = menuNamespaceFor(entry.agent);
    const entityId = entityIdFor(this.runtime);
    await ensureNamespace(this.runtime, roomId, entityId);

    const createdAt = nextCreatedAt(roomId);
    const memory: Memory = {
      entityId,
      agentId: this.runtime.agentId,
      roomId,
      createdAt,
      content: {
        memwalMenuBlobId: entry.blobId,
        memwalMenuAgent: entry.agent,
        memwalMenuSourceHash: entry.sourceHash,
        memwalMenuCreatedAt: createdAt,
        // A non-empty text keeps parity with how memories are stored; not load-bearing.
        text: `menu:${entry.agent}`,
        source: "memwal-menu",
      },
    };
    return this.runtime.createMemory(memory, MENU_TABLE);
  }

  /** Full menu records for an agent, NEWEST-first. Unknown agent -> empty array. */
  async list(agent: string): Promise<readonly MenuIndexRecord[]> {
    const roomId = menuNamespaceFor(agent);
    const memories = await this.runtime.getMemories({
      roomId,
      tableName: MENU_TABLE,
      count: 1000,
    });
    const records = memories
      .map((memory) => toRecord(memory))
      .filter((record): record is MenuIndexRecord => record !== undefined);
    return [...records].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The newest full record for an agent, or undefined. */
  async latestRecord(agent: string): Promise<MenuIndexRecord | undefined> {
    return (await this.list(agent))[0];
  }

  /** The newest menu blobId for an agent, or undefined. */
  async latest(agent: string): Promise<string | undefined> {
    return (await this.latestRecord(agent))?.blobId;
  }
}

function toRecord(memory: Memory): MenuIndexRecord | undefined {
  const content = memory.content ?? {};
  const blobId = content.memwalMenuBlobId;
  if (typeof blobId !== "string") return undefined;
  const agent = typeof content.memwalMenuAgent === "string" ? content.memwalMenuAgent : "";
  const sourceHash =
    typeof content.memwalMenuSourceHash === "string" ? content.memwalMenuSourceHash : "";
  const createdAt =
    typeof content.memwalMenuCreatedAt === "number"
      ? content.memwalMenuCreatedAt
      : memory.createdAt ?? 0;
  return { blobId, agent, sourceHash, createdAt };
}
