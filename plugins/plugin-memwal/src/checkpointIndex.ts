// checkpointIndex.ts — SQLite-backed checkpoint INDEX (A1, Task 3).
//
// Resolves (user, agent[, session]) -> blobId(s), newest-first. The index is
// backed by the runtime's LOCAL DB (@elizaos/plugin-sql) so records SURVIVE a
// service restart — NOT an in-memory map and NOT the demo's demo-state.json file
// (that file pattern is the DEMO's; the plugin uses the runtime DB per PLAN.md
// "Local/SQLite-backed"). It is a private collaborator OWNED by MemwalService:
// the service self-records on every successful writeCheckpoint and exposes only
// READ methods to callers (mirrors plugin-walrus recordHandle — no public mutator,
// thus NO action->service write path).
//
// Verified against @elizaos/core 1.7.2 + @elizaos/plugin-sql 1.7.2:
//   - runtime.createMemory(memory: Memory, tableName: string): Promise<UUID>
//   - runtime.getMemories({ roomId, tableName, count? }): Promise<Memory[]>
// We use a DEDICATED tableName ("memwal_checkpoints"), NOT the "messages" table
// (that is chat). Two facts from chatMemory.ts drive the implementation:
//   1. plugin-sql's memories table has NOT-NULL/foreign-key columns; the room and
//      speaking entity must exist before createMemory or the insert violates a
//      foreign key. We call runtime.ensureConnection(...) first (idempotent).
//   2. getMemories returns NEWEST-first (ORDER BY created_at DESC), and two writes
//      in the same millisecond would tie. We stamp each record with a strictly
//      increasing per-namespace createdAt so back-to-back checkpoints for the same
//      (user, agent) have a deterministic newest-first order.
//
// KEYING — the (user, agent[, session]) -> roomId map (decide and document):
//   The runtime memory API queries by roomId (a UUID), but the index resolves on
//   (user, agent). We derive a DETERMINISTIC UUID from the pair via
//   stringToUuid(`memwal:${user}:${agent}`) and use THAT as the roomId for the
//   index records — a NAMESPACE, not chat's room. So getMemories({ roomId, ... })
//   returns exactly that pair's checkpoints. The full record (blobId, user, agent,
//   session, createdAt, summary preview) lives in the memory's content; session is
//   stored and exposed as an optional filter, but primary resolution is by
//   (user, agent).
//
//   This derived id is a NAMESPACE, not a secret/key — it is a stable, public
//   addressing label so a pair's checkpoints land in one queryable bucket. It
//   grants NO access and protects NO data; confidentiality is the seam's concern
//   (A2 / Seal), never this id's. It matters for the memory model: one pair's
//   query must NEVER return another pair's checkpoint (namespaces are disjoint by
//   construction — distinct (user, agent) pairs hash to distinct roomIds).

import { stringToUuid, ChannelType } from "@elizaos/core";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";

// Dedicated table for index records. NOT "messages" (chat lives there).
const CHECKPOINT_TABLE = "memwal_checkpoints";

// A short summary preview is stored for at-a-glance debugging; the blobId is the
// load-bearing value the index resolves to. Cap the preview so the index record
// stays small (the full summary lives in the checkpoint blob on Walrus).
const SUMMARY_PREVIEW_MAX = 120;

/**
 * A resolved index record. A small READONLY type local to the index — it does NOT
 * touch the locked types.ts result unions. blobId is the load-bearing field; the
 * rest mirror the checkpoint's index-key triple plus ordering/preview metadata.
 */
export interface CheckpointIndexRecord {
  readonly blobId: string;
  readonly user: string;
  readonly agent: string;
  readonly session: string;
  readonly createdAt: number;
  readonly summaryPreview: string;
}

/** The (user, agent, session) + blobId an index entry records. */
export interface IndexEntryInput {
  readonly user: string;
  readonly agent: string;
  readonly session: string;
  readonly blobId: string;
  readonly summary: string;
}

// Per-namespace monotonic timestamp source. Guarantees strictly increasing
// createdAt values within a process even for back-to-back writes in the same
// millisecond, so newest-first read-back ordering is deterministic. Keyed by the
// derived namespace UUID so distinct (user, agent) pairs never share a clock.
const lastStamp = new Map<string, number>();

function nextCreatedAt(namespace: string): number {
  const now = Date.now();
  const prev = lastStamp.get(namespace) ?? 0;
  const stamp = now > prev ? now : prev + 1;
  lastStamp.set(namespace, stamp);
  return stamp;
}

// Derive the stable NAMESPACE roomId for a (user, agent) pair. Distinct pairs hash
// to distinct UUIDs, so their index buckets are disjoint by construction — this is
// what keeps one pair's query from ever returning another pair's checkpoint.
// LENGTH-PREFIXING each component (`${len}:${value}`) makes the join INJECTIVE: a
// raw `:` join lets ("a:b","c") and ("a","b:c") collapse to the same string and
// share a bucket; with the length prefix every distinct pair maps to a distinct
// namespace, so a `:` in a user/agent id can never reach another pair's bucket.
// Deterministic: same pair -> same UUID across processes/restarts.
// NOTE: this scheme differs from the old raw-`:` join, so it yields DIFFERENT
// UUIDs for a given pair — fine here (A1 unshipped, no persisted data), but
// old-scheme ids will not resolve under it.
function namespaceFor(user: string, agent: string): UUID {
  return stringToUuid(`memwal:${user.length}:${user}:${agent.length}:${agent}`);
}

// The entity that "authors" an index record. The index is service-owned book-
// keeping, not a chat turn, so we attribute records to the agent runtime's own
// entity — a stable id that already satisfies the memories table's agent FK.
function entityIdFor(runtime: IAgentRuntime): UUID {
  return runtime.agentId;
}

// Ensure the namespace room + authoring entity exist before createMemory, or the
// insert violates a plugin-sql foreign key (fk_room / fk_user / fk_agent). Mirrors
// chatMemory.ts ensureRoomAndEntity; idempotent (safe to call on every write).
async function ensureNamespace(
  runtime: IAgentRuntime,
  roomId: UUID,
  entityId: UUID,
): Promise<void> {
  const worldId = stringToUuid(`memwal-world:${roomId}`);
  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    name: "memwal-checkpoint-index",
    source: "memwal",
    type: ChannelType.DM,
  });
}

function clampPreview(summary: string): string {
  if (summary.length <= SUMMARY_PREVIEW_MAX) return summary;
  return summary.slice(0, SUMMARY_PREVIEW_MAX);
}

/**
 * SQLite-backed checkpoint index. A private collaborator the service holds; it
 * exposes a single WRITE entry (record) the service calls on its own ok:true path
 * plus READ resolvers. Construction takes only the runtime — all persistence is
 * the runtime's local DB, so a fresh instance against the SAME DB sees prior
 * records (restart survival).
 */
export class CheckpointIndex {
  private readonly runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  /**
   * Persist ONE index entry for a successful checkpoint write. Ensures the
   * namespace room + authoring entity exist, then writes a record into the
   * dedicated index table under the (user, agent) namespace roomId. Returns the
   * new record id. The service is the only caller — there is no public path for an
   * action to mutate the index.
   */
  async record(entry: IndexEntryInput): Promise<UUID> {
    const roomId = namespaceFor(entry.user, entry.agent);
    const entityId = entityIdFor(this.runtime);
    await ensureNamespace(this.runtime, roomId, entityId);

    const createdAt = nextCreatedAt(roomId);
    const memory: Memory = {
      entityId,
      agentId: this.runtime.agentId,
      roomId,
      createdAt,
      content: {
        // Full record fields — read back without a join. The index resolves on
        // (user, agent); session is stored for optional same-bucket filtering.
        memwalBlobId: entry.blobId,
        memwalUser: entry.user,
        memwalAgent: entry.agent,
        memwalSession: entry.session,
        memwalCreatedAt: createdAt,
        // Human-glance preview only; the authoritative summary is in the blob.
        text: clampPreview(entry.summary),
        source: "memwal",
      },
    };
    return this.runtime.createMemory(memory, CHECKPOINT_TABLE);
  }

  /**
   * Resolve the full index records for a (user, agent) pair, NEWEST-first. An
   * unknown pair resolves to an EMPTY array (never a throw). When `session` is
   * given, the same-namespace records are filtered to that session.
   */
  async list(
    user: string,
    agent: string,
    session?: string,
  ): Promise<readonly CheckpointIndexRecord[]> {
    const roomId = namespaceFor(user, agent);
    const memories = await this.runtime.getMemories({
      roomId,
      tableName: CHECKPOINT_TABLE,
      count: 1000,
    });

    const records = memories
      .map((memory) => toRecord(memory))
      .filter((record): record is CheckpointIndexRecord => record !== undefined);

    const scoped =
      session === undefined
        ? records
        : records.filter((record) => record.session === session);

    // getMemories is newest-first by created_at; re-sort defensively on the
    // stamped createdAt so the contract holds even if the adapter's tie-break
    // differs from ours. Newest-first => descending createdAt.
    return [...scoped].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Resolve just the blobIds for a (user, agent) pair, NEWEST-first. Empty for an
   * unknown pair. Convenience over list() for the common "which blobs?" query.
   */
  async listBlobIds(
    user: string,
    agent: string,
    session?: string,
  ): Promise<readonly string[]> {
    const records = await this.list(user, agent, session);
    return records.map((record) => record.blobId);
  }

  /**
   * The single newest blobId for a (user, agent) pair, or undefined if none.
   */
  async latest(
    user: string,
    agent: string,
    session?: string,
  ): Promise<string | undefined> {
    const blobIds = await this.listBlobIds(user, agent, session);
    return blobIds[0];
  }
}

// Reconstruct a record from a stored memory. Returns undefined for a memory that
// is missing the load-bearing blobId (defensive: never surface a partial record).
function toRecord(memory: Memory): CheckpointIndexRecord | undefined {
  const content = memory.content ?? {};
  const blobId = content.memwalBlobId;
  if (typeof blobId !== "string") return undefined;

  const user = typeof content.memwalUser === "string" ? content.memwalUser : "";
  const agent = typeof content.memwalAgent === "string" ? content.memwalAgent : "";
  const session =
    typeof content.memwalSession === "string" ? content.memwalSession : "";
  const createdAt =
    typeof content.memwalCreatedAt === "number"
      ? content.memwalCreatedAt
      : memory.createdAt ?? 0;
  const summaryPreview = typeof content.text === "string" ? content.text : "";

  return { blobId, user, agent, session, createdAt, summaryPreview };
}
