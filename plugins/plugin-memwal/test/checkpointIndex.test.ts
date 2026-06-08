// Non-live unit tests for the SQLite-backed checkpoint INDEX (A1, Task 3).
//
// These drive the index THROUGH MemwalService (the service owns it; there is no
// public index mutator). NO network, NO real WalrusService, NO ElizaOS harness.
//
// The index requires a runtime whose createMemory/getMemories/ensureConnection are
// backed by a store that PERSISTS across two MemwalService.start calls (restart-
// survival is the load-bearing criterion). The existing memwalService.test.ts uses
// a pure stub with no DB, so here we stand up a tiny FakeDb that genuinely
// simulates plugin-sql's behavior:
//   - createMemory appends a row keyed by (tableName, roomId);
//   - getMemories returns rows for a (tableName, roomId), NEWEST-first
//     (created_at DESC), exactly like plugin-sql;
//   - ensureConnection records the room so a createMemory into an unknown room
//     would surface the foreign-key discipline (mirrors the real NOT-NULL/FK
//     columns the service must satisfy first).
// A SINGLE FakeDb instance shared by two runtimes is the in-test stand-in for one
// on-disk SQLite file two service instances open in turn.

import { test } from "node:test";
import assert from "node:assert/strict";

import { stringToUuid } from "@elizaos/core";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";

import { MemwalService } from "../src/memwalService.js";
import type { Checkpoint } from "../src/types.js";

// --- Fake Walrus (capturing, monotonic blobIds) ------------------------------
type FakeStoreResult = { ok: true; blobId: string; sizeBytes: number };

type FakeWalrus = {
  serviceType: "walrus";
  store(bytes: Uint8Array): Promise<FakeStoreResult>;
};

function makeFakeWalrus(): FakeWalrus {
  let n = 0;
  return {
    serviceType: "walrus",
    async store(bytes: Uint8Array): Promise<FakeStoreResult> {
      n += 1;
      return { ok: true, blobId: `blob-${n}`, sizeBytes: bytes.length };
    },
  };
}

// --- Fake persistent DB (simulates plugin-sql's memories table) --------------
// Rows are kept by (tableName + roomId) bucket. getMemories returns newest-first.
// ensureConnection records known rooms so createMemory into an unknown room throws
// (the FK discipline the service must respect by calling ensureConnection first).
class FakeDb {
  private readonly rooms = new Set<string>();
  private readonly rows = new Map<string, Memory[]>();

  private static key(tableName: string, roomId: string): string {
    return `${tableName}::${roomId}`;
  }

  ensureRoom(roomId: string): void {
    this.rooms.add(roomId);
  }

  createMemory(memory: Memory, tableName: string): UUID {
    const roomId = memory.roomId;
    if (!this.rooms.has(roomId)) {
      // Simulate the plugin-sql foreign-key violation the service avoids by
      // calling ensureConnection before every createMemory.
      throw new Error(`FK violation: room ${roomId} does not exist`);
    }
    const key = FakeDb.key(tableName, roomId);
    const id = stringToUuid(`row:${key}:${(this.rows.get(key)?.length ?? 0)}`);
    const stored: Memory = { ...memory, id };
    // Build a NEW array (immutability); never mutate the existing one in place.
    this.rows.set(key, [...(this.rows.get(key) ?? []), stored]);
    return id;
  }

  getMemories(tableName: string, roomId: string, count: number): Memory[] {
    const key = FakeDb.key(tableName, roomId);
    const rows = this.rows.get(key) ?? [];
    // Newest-first like plugin-sql (ORDER BY created_at DESC, id DESC). Use a
    // stable sort fed by createdAt; ties keep insertion order reversed.
    return [...rows]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, count);
  }
}

// Build a runtime whose memory API is backed by the shared FakeDb and whose
// getService("walrus") resolves the fake Walrus. A fixed agentId satisfies the
// agent FK; ensureConnection records the room into the FakeDb.
function makeRuntime(db: FakeDb, walrus: FakeWalrus): IAgentRuntime {
  const agentId = stringToUuid("memwal-test-agent");
  return {
    agentId,
    getService: (serviceType: string) =>
      serviceType === "walrus" ? walrus : null,
    ensureConnection: async ({ roomId }: { roomId: UUID }) => {
      db.ensureRoom(roomId);
    },
    createMemory: async (memory: Memory, tableName: string) =>
      db.createMemory(memory, tableName),
    getMemories: async ({
      roomId,
      tableName,
      count = 1000,
    }: {
      roomId?: UUID;
      tableName: string;
      count?: number;
    }) => db.getMemories(tableName, roomId ?? ("" as UUID), count),
  } as unknown as IAgentRuntime;
}

function checkpointFor(
  user: string,
  agent: string,
  session: string,
  summary: string,
): Checkpoint {
  return {
    roomId: `room-${user}-${agent}`,
    createdAt: 1717900000000,
    turnCount: 3,
    summary,
    user,
    agent,
    session,
  };
}

// Case 1 — two checkpoints, SAME (user, agent) -> both blobIds, NEWEST-first.
test("listCheckpoints returns both blobIds for the same (user, agent), newest-first", async () => {
  const db = new FakeDb();
  const walrus = makeFakeWalrus();
  const service = MemwalService.fromConfig(undefined, makeRuntime(db, walrus));

  const w1 = await service.writeCheckpoint(checkpointFor("u1", "a1", "s1", "first"));
  const w2 = await service.writeCheckpoint(checkpointFor("u1", "a1", "s1", "second"));
  assert.ok(w1.ok && w2.ok);

  const blobIds = await service.listCheckpoints("u1", "a1");
  assert.deepEqual([...blobIds], [w2.blobId, w1.blobId]);

  // latest() is the convenience for the newest.
  assert.equal(await service.latest("u1", "a1"), w2.blobId);
});

// Case 2 — unknown (user, agent) -> EMPTY array, no throw.
test("listCheckpoints for an unknown (user, agent) returns empty, no throw", async () => {
  const db = new FakeDb();
  const service = MemwalService.fromConfig(undefined, makeRuntime(db, makeFakeWalrus()));

  const blobIds = await service.listCheckpoints("nobody", "nothing");
  assert.deepEqual([...blobIds], []);
  assert.equal(await service.latest("nobody", "nothing"), undefined);
});

// Case 3 — RESTART survival: write via one service, then start a SECOND service
// against the SAME backing DB and resolve the records.
test("index records survive a service restart (fresh service, same DB)", async () => {
  const db = new FakeDb();
  const walrus = makeFakeWalrus();

  // First service instance writes a checkpoint.
  const first = MemwalService.fromConfig(undefined, makeRuntime(db, walrus));
  const w = await first.writeCheckpoint(checkpointFor("u2", "a2", "s2", "persist me"));
  assert.ok(w.ok);
  await first.stop();

  // SECOND, fresh service instance against the SAME FakeDb (the on-disk-file
  // stand-in). start() builds a brand-new MemwalService — no shared in-memory
  // index state — so resolving here proves persistence is in the DB, not the map.
  const second = await MemwalService.start(makeRuntime(db, walrus));
  const blobIds = await second.listCheckpoints("u2", "a2");
  assert.deepEqual([...blobIds], [w.blobId]);
});

// Case 4 — ISOLATION: pair A's query never returns pair B's blobId (the namespace
// is disjoint; matters for the memory model).
test("distinct (user, agent) pairs do not bleed into each other", async () => {
  const db = new FakeDb();
  const walrus = makeFakeWalrus();
  const service = MemwalService.fromConfig(undefined, makeRuntime(db, walrus));

  const wa = await service.writeCheckpoint(checkpointFor("alice", "agentA", "s", "A"));
  const wb = await service.writeCheckpoint(checkpointFor("bob", "agentB", "s", "B"));
  assert.ok(wa.ok && wb.ok);

  const aBlobs = await service.listCheckpoints("alice", "agentA");
  const bBlobs = await service.listCheckpoints("bob", "agentB");

  assert.deepEqual([...aBlobs], [wa.blobId]);
  assert.deepEqual([...bBlobs], [wb.blobId]);
  // Cross-check: neither query leaks the other pair's blobId.
  assert.ok(!aBlobs.includes(wb.blobId));
  assert.ok(!bBlobs.includes(wa.blobId));
});

// Case 4b — DELIMITER-COLLISION ISOLATION (memory model): two pairs that would
// collapse to the SAME namespace under a raw `:` join — ("a:b","c") vs ("a","b:c"),
// both of which would render as "memwal:a:b:c" — must now map to DISJOINT buckets.
// Each pair's listCheckpoints returns ONLY its own blobId, never the other's. This
// is the load-bearing isolation guarantee: a `:` in an id can never reach another
// pair's checkpoints.
test("delimiter-colliding (user, agent) pairs map to disjoint buckets", async () => {
  const db = new FakeDb();
  const walrus = makeFakeWalrus();
  const service = MemwalService.fromConfig(undefined, makeRuntime(db, walrus));

  // Under the OLD raw-`:` join both of these derive `memwal:a:b:c` and collide.
  const wAB = await service.writeCheckpoint(checkpointFor("a:b", "c", "s", "AB"));
  const wBC = await service.writeCheckpoint(checkpointFor("a", "b:c", "s", "BC"));
  assert.ok(wAB.ok && wBC.ok);

  const abBlobs = await service.listCheckpoints("a:b", "c");
  const bcBlobs = await service.listCheckpoints("a", "b:c");

  // Each pair sees ONLY its own blob.
  assert.deepEqual([...abBlobs], [wAB.blobId]);
  assert.deepEqual([...bcBlobs], [wBC.blobId]);
  // Cross-check: neither bucket leaks the other's blobId (no collision).
  assert.ok(!abBlobs.includes(wBC.blobId));
  assert.ok(!bcBlobs.includes(wAB.blobId));
});

// Case 5 — session is stored and filterable WITHIN a (user, agent) bucket, while
// primary resolution stays by (user, agent). Proves the (session) part of the key.
test("session filters within a (user, agent) bucket without splitting the namespace", async () => {
  const db = new FakeDb();
  const walrus = makeFakeWalrus();
  const service = MemwalService.fromConfig(undefined, makeRuntime(db, walrus));

  const wx = await service.writeCheckpoint(checkpointFor("u3", "a3", "sessX", "x"));
  const wy = await service.writeCheckpoint(checkpointFor("u3", "a3", "sessY", "y"));
  assert.ok(wx.ok && wy.ok);

  // Primary (user, agent) resolution returns BOTH sessions, newest-first.
  const all = await service.listCheckpoints("u3", "a3");
  assert.deepEqual([...all], [wy.blobId, wx.blobId]);

  // Optional session filter narrows to one within the same bucket.
  assert.deepEqual([...(await service.listCheckpoints("u3", "a3", "sessX"))], [wx.blobId]);
  assert.deepEqual([...(await service.listCheckpoints("u3", "a3", "sessY"))], [wy.blobId]);
});
