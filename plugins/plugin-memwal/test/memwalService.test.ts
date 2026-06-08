// Non-live unit tests for MemwalService (A1, Task 2).
//
// These drive MemwalService directly with a STUB runtime (a plain object cast to
// IAgentRuntime) whose getService("walrus") returns a FAKE Walrus service — NO
// network, NO real WalrusService, NO ElizaOS harness. The fake exposes just the
// store/read slice MemWal calls and returns canned typed results.
//
// The fake captures the exact bytes writeCheckpoint hands to store(), and replays
// those same bytes through read(), so a round-trip proves byte-faithfulness end to
// end (plain mode AND seam-present mode), plus the malformed-blob and passthrough
// failure mappings.

import { test } from "node:test";
import assert from "node:assert/strict";

import { stringToUuid } from "@elizaos/core";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";

import { MemwalService } from "../src/memwalService.js";
import type { Checkpoint, MemwalSeam } from "../src/types.js";

// Mirror of the Walrus store/read result shapes MemWal consumes (kind names are
// reused from plugin-walrus). Only the variants the tests produce are built here.
type FakeStoreResult =
  | { ok: true; blobId: string; sizeBytes: number }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false };

type FakeReadResult =
  | { ok: true; bytes: Uint8Array; blobId: string }
  | { ok: false; kind: "blob_unavailable"; blobId: string; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false };

// A capturing fake Walrus service. store() records the bytes it received and hands
// back a fixed blobId; read() returns whatever the configured reader produces (by
// default, the captured store bytes — i.e. a real round-trip). serviceType is
// present so a getService("walrus") stub can resolve it.
type FakeWalrus = {
  serviceType: "walrus";
  stored: Uint8Array[];
  store(bytes: Uint8Array): Promise<FakeStoreResult>;
  read(blobId: string): Promise<FakeReadResult>;
};

const FIXED_BLOB_ID = "fake-blob-1";

function makeFakeWalrus(opts?: {
  storeResult?: (bytes: Uint8Array) => FakeStoreResult;
  readResult?: (blobId: string, stored: Uint8Array[]) => FakeReadResult;
}): FakeWalrus {
  const stored: Uint8Array[] = [];
  return {
    serviceType: "walrus",
    stored,
    async store(bytes: Uint8Array): Promise<FakeStoreResult> {
      // Defensive COPY so a later in-place mutation by the caller cannot rewrite
      // what we "persisted" — proves the bytes crossing the boundary are faithful.
      stored.push(Uint8Array.from(bytes));
      return opts?.storeResult
        ? opts.storeResult(bytes)
        : { ok: true, blobId: FIXED_BLOB_ID, sizeBytes: bytes.length };
    },
    async read(blobId: string): Promise<FakeReadResult> {
      if (opts?.readResult) return opts.readResult(blobId, stored);
      const last = stored[stored.length - 1];
      if (last === undefined) {
        return { ok: false, kind: "blob_unavailable", blobId, errorName: "NotStored", message: "nothing stored", retryable: false };
      }
      return { ok: true, bytes: Uint8Array.from(last), blobId };
    },
  };
}

// Stub runtime: getService(name) returns the fake only for "walrus", else null.
function runtimeWith(walrus: FakeWalrus | null): IAgentRuntime {
  return {
    getService: (serviceType: string) => (serviceType === "walrus" ? walrus : null),
  } as unknown as IAgentRuntime;
}

// --- Index-capable runtime for the `indexed` signal tests --------------------
// Provides the memory API the CheckpointIndex needs (ensureConnection/createMemory
// /getMemories) plus a captured warn-logger, so a write exercises the real index
// write path. `failRecord` flips createMemory to REJECT (simulating an index/DB
// write failure) so writeCheckpoint must keep ok:true with indexed:false and warn.
type WarnCall = { obj: unknown; msg?: string };

function makeIndexRuntime(
  walrus: FakeWalrus,
  opts?: { failRecord?: boolean },
): { runtime: IAgentRuntime; warns: WarnCall[] } {
  const warns: WarnCall[] = [];
  const rows: Memory[] = [];
  const runtime = {
    agentId: stringToUuid("memwal-svc-test-agent"),
    logger: {
      warn: (obj: unknown, msg?: string) => {
        warns.push({ obj, msg });
      },
    },
    getService: (serviceType: string) => (serviceType === "walrus" ? walrus : null),
    ensureConnection: async (_args: { roomId: UUID }) => {},
    createMemory: async (memory: Memory, _tableName: string): Promise<UUID> => {
      if (opts?.failRecord) {
        throw new Error("simulated index write failure");
      }
      const id = stringToUuid(`row:${rows.length}`);
      rows.push({ ...memory, id });
      return id;
    },
    getMemories: async ({ count = 1000 }: { count?: number }): Promise<Memory[]> =>
      [...rows].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, count),
  } as unknown as IAgentRuntime;
  return { runtime, warns };
}

const sampleCheckpoint: Checkpoint = {
  roomId: "room-abc",
  createdAt: 1717900000000,
  turnCount: 7,
  summary: "User wants to schedule a job; collected name, missing budget.",
  user: "user-1",
  agent: "agent-1",
  session: "session-1",
};

// Case 1 — byte-faithful round-trip, seam EMPTY (plain mode). Uses the index-
// capable runtime so the write takes the CLEAN path (indexed:true, no warn) — the
// byte-faithfulness proof must not run through a degraded index-failing write.
test("round-trips a checkpoint byte-faithfully with an EMPTY seam", async () => {
  const walrus = makeFakeWalrus();
  const { runtime, warns } = makeIndexRuntime(walrus);
  const service = MemwalService.fromConfig(undefined, runtime);

  const write = await service.writeCheckpoint(sampleCheckpoint);
  assert.equal(write.ok, true);
  assert.ok(write.ok); // narrow
  assert.equal(write.blobId, FIXED_BLOB_ID);
  assert.equal(write.indexed, true); // clean write path
  assert.equal(warns.length, 0, "no warn on a clean round-trip write");

  // Plain mode: the bytes Walrus received are exactly JSON.stringify(checkpoint).
  const expectedBytes = new TextEncoder().encode(JSON.stringify(sampleCheckpoint));
  assert.deepEqual(walrus.stored[0], expectedBytes);

  // Feed those same bytes back through readCheckpoint (the fake replays them).
  const read = await service.readCheckpoint(write.blobId);
  assert.equal(read.ok, true);
  assert.ok(read.ok); // narrow
  assert.deepEqual(read.checkpoint, sampleCheckpoint);
});

// Case 2 — byte-faithful round-trip, seam PRESENT (reversible XOR), seam exercised.
test("round-trips through a PRESENT (reversible) seam and invokes both hooks", async () => {
  const XOR = 0x5a;
  const xorAll = (bytes: Uint8Array): Uint8Array => bytes.map((b) => b ^ XOR);

  const counters = { encrypt: 0, decrypt: 0 };
  const seam: MemwalSeam = {
    encrypt: async (bytes) => {
      counters.encrypt += 1;
      return xorAll(bytes);
    },
    decrypt: async (bytes) => {
      counters.decrypt += 1;
      return xorAll(bytes);
    },
  };

  const walrus = makeFakeWalrus();
  const { runtime, warns } = makeIndexRuntime(walrus);
  const service = MemwalService.fromConfig(seam, runtime);

  const write = await service.writeCheckpoint(sampleCheckpoint);
  assert.ok(write.ok);
  assert.equal(write.indexed, true); // clean write path
  assert.equal(warns.length, 0, "no warn on a clean round-trip write");

  // The stored bytes are the CIPHER (XORed), not the plaintext JSON.
  const plainBytes = new TextEncoder().encode(JSON.stringify(sampleCheckpoint));
  assert.notDeepEqual(walrus.stored[0], plainBytes);
  assert.deepEqual(walrus.stored[0], xorAll(plainBytes));

  const read = await service.readCheckpoint(write.blobId);
  assert.ok(read.ok);
  assert.deepEqual(read.checkpoint, sampleCheckpoint);

  // The seam was actually exercised on both legs.
  assert.ok(counters.encrypt > 0, "encrypt hook was never invoked");
  assert.ok(counters.decrypt > 0, "decrypt hook was never invoked");
});

// Case 3 — malformed blob -> invalid_checkpoint (NO throw).
test("a malformed blob maps to invalid_checkpoint without throwing", async () => {
  const walrus = makeFakeWalrus({
    readResult: (blobId) => ({
      ok: true,
      bytes: new TextEncoder().encode(JSON.stringify({ nope: 1 })),
      blobId,
    }),
  });
  const service = MemwalService.fromConfig(undefined, runtimeWith(walrus));

  const read = await service.readCheckpoint("any-blob");
  assert.equal(read.ok, false);
  assert.ok(!read.ok); // narrow
  assert.equal(read.kind, "invalid_checkpoint");
  assert.ok(read.kind === "invalid_checkpoint");
  assert.equal(read.blobId, "any-blob");
  assert.equal(read.retryable, false);
});

// Case 3b — non-JSON bytes also map to invalid_checkpoint (parse error, no throw).
test("non-JSON bytes map to invalid_checkpoint without throwing", async () => {
  const walrus = makeFakeWalrus({
    readResult: (blobId) => ({
      ok: true,
      bytes: new TextEncoder().encode("definitely not json {"),
      blobId,
    }),
  });
  const service = MemwalService.fromConfig(undefined, runtimeWith(walrus));

  const read = await service.readCheckpoint("blob-x");
  assert.ok(!read.ok);
  assert.equal(read.kind, "invalid_checkpoint");
});

// Case 4 — passthrough: Walrus read blob_unavailable maps straight through.
test("a Walrus blob_unavailable read maps straight through", async () => {
  const walrus = makeFakeWalrus({
    readResult: (blobId) => ({
      ok: false,
      kind: "blob_unavailable",
      blobId,
      errorName: "BlobNotCertifiedError",
      message: "blob not certified",
      retryable: false,
    }),
  });
  const service = MemwalService.fromConfig(undefined, runtimeWith(walrus));

  const read = await service.readCheckpoint("missing-blob");
  assert.ok(!read.ok);
  assert.equal(read.kind, "blob_unavailable");
  assert.ok(read.kind === "blob_unavailable");
  assert.equal(read.blobId, "missing-blob");
});

// Case 5 — Walrus store network_error passes straight through on write.
test("a Walrus store network_error maps straight through on write", async () => {
  const walrus = makeFakeWalrus({
    storeResult: () => ({
      ok: false,
      kind: "network_error",
      errorName: "FetchError",
      message: "connection reset",
      retryable: true,
    }),
  });
  const service = MemwalService.fromConfig(undefined, runtimeWith(walrus));

  const write = await service.writeCheckpoint(sampleCheckpoint);
  assert.ok(!write.ok);
  assert.equal(write.kind, "network_error");
  assert.ok(write.kind === "network_error");
  assert.equal(write.retryable, true);
});

// Case 6 — absent Walrus service -> typed config_error (NOT a throw) on both ops.
test("an absent Walrus service yields config_error, never a throw", async () => {
  const service = MemwalService.fromConfig(undefined, runtimeWith(null));

  const write = await service.writeCheckpoint(sampleCheckpoint);
  assert.ok(!write.ok);
  assert.equal(write.kind, "config_error");

  const read = await service.readCheckpoint("any");
  assert.ok(!read.ok);
  assert.equal(read.kind, "config_error");
});

// Case 7 — INDEXED SIGNAL (Fix 1, happy path): when the index records the entry,
// the ok:true result carries indexed === true and no warn is emitted.
test("a successful index write reports indexed: true", async () => {
  const walrus = makeFakeWalrus();
  const { runtime, warns } = makeIndexRuntime(walrus);
  const service = MemwalService.fromConfig(undefined, runtime);

  const write = await service.writeCheckpoint(sampleCheckpoint);
  assert.ok(write.ok); // narrow
  assert.equal(write.blobId, FIXED_BLOB_ID);
  assert.equal(write.indexed, true);
  assert.equal(warns.length, 0, "no warn should be emitted on a successful index write");
});

// Case 8 — INDEXED SIGNAL (Fix 1, failure path): when index.record throws, the
// blob is still durable so the result stays ok:true WITH the blobId, but indexed
// is false AND a warn naming the blobId + (user, agent, session) is emitted. This
// proves the failure is no longer SILENTLY swallowed (no orphaned checkpoint).
test("a failing index write stays ok:true with the blobId, indexed: false, and warns", async () => {
  const walrus = makeFakeWalrus();
  const { runtime, warns } = makeIndexRuntime(walrus, { failRecord: true });
  const service = MemwalService.fromConfig(undefined, runtime);

  const write = await service.writeCheckpoint(sampleCheckpoint);
  assert.ok(write.ok); // store succeeded -> ok:true
  assert.equal(write.blobId, FIXED_BLOB_ID); // blob is durable; blobId returned
  assert.equal(write.indexed, false); // but the index entry did NOT land

  // The failure was made VISIBLE: exactly one warn naming the lost mapping.
  assert.equal(warns.length, 1);
  const msg = warns[0]?.msg ?? "";
  assert.ok(msg.includes(FIXED_BLOB_ID), "warn names the blobId");
  assert.ok(msg.includes(sampleCheckpoint.user), "warn names the user");
  assert.ok(msg.includes(sampleCheckpoint.agent), "warn names the agent");
  assert.ok(msg.includes(sampleCheckpoint.session), "warn names the session");
});
