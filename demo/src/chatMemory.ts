// Thin wrappers over the ElizaOS runtime memory API so the demo can persist and
// list chat turns in the LOCAL DB (PGlite, the demo's "SQLite" tier).
//
// Verified against @elizaos/core 1.7.2 + @elizaos/plugin-sql 1.7.2:
//   - runtime.createMemory(memory: Memory, tableName: string): Promise<UUID>
//   - runtime.getMemories({ roomId, tableName, count? }): Promise<Memory[]>
//   The core runtime's own message memory uses tableName "messages", so we use
//   the same table -- chat turns written here share the runtime's message store.
//
// Two facts drove the implementation:
//   1. plugin-sql's memories table has NOT-NULL/foreign-key columns for agentId
//      and FK refs for roomId + entityId. So the room and the speaking entity
//      must exist before createMemory, or the insert violates a foreign key. We
//      call runtime.ensureConnection(...) first, which creates the world, room,
//      entity, and participant rows idempotently.
//   2. getMemories returns NEWEST-first (ORDER BY created_at DESC, id DESC), and
//      two turns written in the same millisecond would tie. To return a stable
//      oldest-first list we stamp each turn with a strictly increasing createdAt
//      (a per-room monotonic clock) and sort ascending on read.

import { stringToUuid, ChannelType } from "@elizaos/core";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";

const MESSAGES_TABLE = "messages";

export type ChatRole = "user" | "agent";

export interface ChatTurn {
  readonly role: ChatRole;
  readonly text: string;
  readonly createdAt: number;
}

export interface SaveTurnInput {
  readonly roomId: string;
  readonly role: ChatRole;
  readonly text: string;
}

// Per-room monotonic timestamp source. Guarantees strictly increasing createdAt
// values within a process even for back-to-back writes in the same millisecond,
// so read-back ordering is deterministic.
const lastStamp = new Map<string, number>();

function nextCreatedAt(roomKey: string): number {
  const now = Date.now();
  const prev = lastStamp.get(roomKey) ?? 0;
  const stamp = now > prev ? now : prev + 1;
  lastStamp.set(roomKey, stamp);
  return stamp;
}

// Stable entity ids per role within a room. The user and the agent are distinct
// speakers; deriving the id from role+room keeps them consistent across calls.
function entityIdFor(runtime: IAgentRuntime, roomId: UUID, role: ChatRole): UUID {
  if (role === "agent") return runtime.agentId;
  return stringToUuid(`demo-user:${roomId}`);
}

async function ensureRoomAndEntity(
  runtime: IAgentRuntime,
  roomId: UUID,
  entityId: UUID,
): Promise<void> {
  const worldId = stringToUuid(`demo-world:${roomId}`);
  // Creates world + room + entity + participant idempotently. Satisfies the
  // memories table foreign keys (fk_room, fk_user, fk_agent) before insert.
  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    name: entityId === runtime.agentId ? "agent" : "user",
    source: "demo",
    type: ChannelType.DM,
  });
}

/**
 * Persist one chat turn (user or agent) to the local DB. Ensures the room and
 * speaking entity exist first, then writes a MESSAGE memory. Returns the new id.
 */
export async function saveTurn(
  runtime: IAgentRuntime,
  input: SaveTurnInput,
): Promise<UUID> {
  const roomId = stringToUuid(input.roomId);
  const entityId = entityIdFor(runtime, roomId, input.role);
  await ensureRoomAndEntity(runtime, roomId, entityId);

  const createdAt = nextCreatedAt(input.roomId);
  const memory: Memory = {
    entityId,
    agentId: runtime.agentId,
    roomId,
    createdAt,
    content: {
      text: input.text,
      source: "demo",
      // Mark who spoke so listTurns can recover the role without a join.
      demoRole: input.role,
    },
  };
  return runtime.createMemory(memory, MESSAGES_TABLE);
}

function roleOf(memory: Memory, agentId: UUID): ChatRole {
  const tagged = memory.content?.demoRole;
  if (tagged === "user" || tagged === "agent") return tagged;
  // Fallback: anything authored by the agent entity is an agent turn.
  return memory.entityId === agentId ? "agent" : "user";
}

/**
 * List all chat turns for a room from the local DB, oldest-first. Reads via the
 * runtime memory API (newest-first) and sorts ascending by createdAt.
 */
export async function listTurns(
  runtime: IAgentRuntime,
  roomId: string,
  count = 1000,
): Promise<ChatTurn[]> {
  const resolvedRoom = stringToUuid(roomId);
  const memories = await runtime.getMemories({
    roomId: resolvedRoom,
    tableName: MESSAGES_TABLE,
    count,
  });

  return memories
    .map((memory) => ({
      role: roleOf(memory, runtime.agentId),
      text: typeof memory.content?.text === "string" ? memory.content.text : "",
      createdAt: memory.createdAt ?? 0,
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}
