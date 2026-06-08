// End-to-end action-surface tests for plugin-memwal (A1, Task 4).
//
// These prove the DONE definition THROUGH THE ACTION SURFACE (not the service):
// register a fake Walrus + a real MemwalService in a bare runtime so
// runtime.getService("memwal") and getService("walrus") both resolve, then invoke
// writeCheckpointAction.handler followed by readCheckpointAction.handler with the
// returned blobId — the recalled checkpoint must DEEP-EQUAL the original. NO
// network, NO real WalrusService, NO ElizaOS harness; the fake Walrus captures the
// bytes write hands it and replays them on read (a genuine round-trip).
//
// The handlers' callback (HandlerCallback) is the PRIMARY surface: a capturing
// callback records the emitted Content and the tests assert on Content.data (the
// MemwalActionCallback), mirroring the plugin-walrus action tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import { stringToUuid } from "@elizaos/core";
import type { Content, HandlerCallback, IAgentRuntime, Memory, UUID } from "@elizaos/core";

import { MemwalService } from "../src/memwalService.js";
import { writeCheckpointAction, MEMWAL_WRITE_CHECKPOINT } from "../src/writeCheckpoint.js";
import { readCheckpointAction, MEMWAL_READ_CHECKPOINT } from "../src/readCheckpoint.js";
import { memwalPlugin } from "../src/index.js";
import type { MemwalActionCallback } from "../src/actionCallback.js";
import type { Checkpoint } from "../src/types.js";

// --- Fake Walrus (capturing, replays stored bytes on read) -------------------
type FakeStoreResult = { ok: true; blobId: string; sizeBytes: number };
type FakeReadResult =
  | { ok: true; bytes: Uint8Array; blobId: string }
  | { ok: false; kind: "blob_unavailable"; blobId: string; errorName: string; message: string; retryable: false };

type FakeWalrus = {
  serviceType: "walrus";
  stored: Map<string, Uint8Array>;
  store(bytes: Uint8Array): Promise<FakeStoreResult>;
  read(blobId: string): Promise<FakeReadResult>;
};

function makeFakeWalrus(): FakeWalrus {
  let n = 0;
  const stored = new Map<string, Uint8Array>();
  return {
    serviceType: "walrus",
    stored,
    async store(bytes: Uint8Array): Promise<FakeStoreResult> {
      n += 1;
      const blobId = `blob-${n}`;
      // Defensive COPY so a later in-place mutation cannot rewrite what we persisted.
      stored.set(blobId, Uint8Array.from(bytes));
      return { ok: true, blobId, sizeBytes: bytes.length };
    },
    async read(blobId: string): Promise<FakeReadResult> {
      const bytes = stored.get(blobId);
      if (bytes === undefined) {
        return {
          ok: false,
          kind: "blob_unavailable",
          blobId,
          errorName: "NotStored",
          message: "nothing stored",
          retryable: false,
        };
      }
      return { ok: true, bytes: Uint8Array.from(bytes), blobId };
    },
  };
}

// Index-capable runtime: provides the memory API the CheckpointIndex needs so the
// write path records an index entry (indexed:true), plus getService resolving the
// real MemwalService for "memwal" and the fake for "walrus". Pass `noWalrus` to
// drop the Walrus registration (the absent-dependency case).
function makeRuntime(opts?: { walrus?: FakeWalrus | null; service?: MemwalService | null }): {
  runtime: IAgentRuntime;
} {
  const rows: Memory[] = [];
  const walrus = opts?.walrus;
  const runtime = {
    agentId: stringToUuid("memwal-action-test-agent"),
    logger: { warn: () => {} },
    ensureConnection: async (_args: { roomId: UUID }) => {},
    createMemory: async (memory: Memory): Promise<UUID> => {
      const id = stringToUuid(`row:${rows.length}`);
      rows.push({ ...memory, id });
      return id;
    },
    getMemories: async ({ count = 1000 }: { count?: number }): Promise<Memory[]> =>
      [...rows].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, count),
    // getService is patched in below once the service exists (it needs the runtime).
    getService: (_serviceType: string): unknown => null,
  } as unknown as IAgentRuntime & { getService: (s: string) => unknown };

  // The MemwalService needs the runtime to resolve Walrus + the index; build it
  // against this runtime (unless the caller forces it absent), then wire getService.
  const service =
    opts?.service === null
      ? null
      : (opts?.service ?? MemwalService.fromConfig(undefined, runtime));
  (runtime as { getService: (s: string) => unknown }).getService = (serviceType: string) => {
    if (serviceType === MemwalService.serviceType) return service;
    if (serviceType === "walrus") return walrus ?? null;
    return null;
  };
  return { runtime };
}

// A capturing callback: records every emitted Content so a test can read the last
// MemwalActionCallback off Content.data.
function capturing(): { callback: HandlerCallback; calls: Content[] } {
  const calls: Content[] = [];
  const callback: HandlerCallback = async (content: Content) => {
    calls.push(content);
    return [];
  };
  return { callback, calls };
}

function lastData(calls: Content[]): MemwalActionCallback {
  const last = calls[calls.length - 1];
  assert.ok(last !== undefined, "a callback was emitted");
  return last.data as unknown as MemwalActionCallback;
}

const sampleCheckpoint: Checkpoint = {
  roomId: "room-abc",
  createdAt: 1717900000000,
  turnCount: 9,
  summary: "User asked to schedule a job; gathered name, awaiting budget.",
  user: "user-1",
  agent: "agent-1",
  session: "session-1",
};

const noop = {} as unknown as Memory;
const noState = undefined;

// Case 1+2 — END-TO-END through the ACTION surface: write returns a blobId
// (indexed:true), then read with THAT blobId reproduces the checkpoint exactly.
test("write then read actions reproduce the checkpoint end-to-end", async () => {
  const walrus = makeFakeWalrus();
  const { runtime } = makeRuntime({ walrus });

  // 1) write action with the structured Checkpoint on options.
  const w = capturing();
  await writeCheckpointAction.handler(
    runtime,
    noop,
    noState,
    { checkpoint: sampleCheckpoint },
    w.callback,
  );
  const writeData = lastData(w.calls);
  assert.equal(writeData.type, "memwal.write.success");
  assert.ok(writeData.type === "memwal.write.success"); // narrow
  assert.equal(typeof writeData.blobId, "string");
  assert.ok(writeData.blobId.length > 0);
  assert.equal(writeData.indexed, true);

  // 2) read action with the returned blobId reproduces the checkpoint.
  const r = capturing();
  await readCheckpointAction.handler(
    runtime,
    noop,
    noState,
    { blobId: writeData.blobId },
    r.callback,
  );
  const readData = lastData(r.calls);
  assert.equal(readData.type, "memwal.read.success");
  assert.ok(readData.type === "memwal.read.success"); // narrow
  assert.deepEqual(readData.checkpoint, sampleCheckpoint);
});

// Case 3 — invalid options on write -> typed memwal.error callback, NO throw.
test("write with malformed options emits memwal.error and does not throw", async () => {
  const walrus = makeFakeWalrus();
  const { runtime } = makeRuntime({ walrus });

  const w = capturing();
  await assert.doesNotReject(() =>
    writeCheckpointAction.handler(
      runtime,
      noop,
      noState,
      { checkpoint: { user: "only-a-user" } },
      w.callback,
    ),
  );
  const data = lastData(w.calls);
  assert.equal(data.type, "memwal.error");
  assert.ok(data.type === "memwal.error"); // narrow
  assert.equal(data.operation, "write");
});

// Case 3b — invalid options on read (missing blobId) -> typed memwal.error, NO throw.
test("read with no blobId emits memwal.error and does not throw", async () => {
  const walrus = makeFakeWalrus();
  const { runtime } = makeRuntime({ walrus });

  const r = capturing();
  await assert.doesNotReject(() =>
    readCheckpointAction.handler(runtime, noop, noState, {}, r.callback),
  );
  const data = lastData(r.calls);
  assert.equal(data.type, "memwal.error");
  assert.ok(data.type === "memwal.error"); // narrow
  assert.equal(data.operation, "read");
});

// Case 4a — absent MEMWAL service -> typed memwal.error callback, NO throw.
test("an absent memwal service yields a memwal.error callback, never a throw", async () => {
  const walrus = makeFakeWalrus();
  const { runtime } = makeRuntime({ walrus, service: null });

  const w = capturing();
  await assert.doesNotReject(() =>
    writeCheckpointAction.handler(
      runtime,
      noop,
      noState,
      { checkpoint: sampleCheckpoint },
      w.callback,
    ),
  );
  const data = lastData(w.calls);
  assert.equal(data.type, "memwal.error");
  assert.ok(data.type === "memwal.error");
  assert.equal(data.operation, "write");

  const r = capturing();
  await assert.doesNotReject(() =>
    readCheckpointAction.handler(runtime, noop, noState, { blobId: "x" }, r.callback),
  );
  assert.equal(lastData(r.calls).type, "memwal.error");
});

// Case 4b — absent WALRUS dependency (memwal present) -> typed memwal.error
// (config_error mapped through the service), NO throw, on both write and read.
test("an absent walrus dependency yields a memwal.error callback, never a throw", async () => {
  const { runtime } = makeRuntime({ walrus: null });

  const w = capturing();
  await assert.doesNotReject(() =>
    writeCheckpointAction.handler(
      runtime,
      noop,
      noState,
      { checkpoint: sampleCheckpoint },
      w.callback,
    ),
  );
  const writeData = lastData(w.calls);
  assert.equal(writeData.type, "memwal.error");
  assert.ok(writeData.type === "memwal.error");
  assert.equal(writeData.operation, "write");

  const r = capturing();
  await assert.doesNotReject(() =>
    readCheckpointAction.handler(runtime, noop, noState, { blobId: "any" }, r.callback),
  );
  const readData = lastData(r.calls);
  assert.equal(readData.type, "memwal.error");
  assert.ok(readData.type === "memwal.error");
  assert.equal(readData.operation, "read");
});

// Case 5 — assembled plugin shape: name, MemwalService class in services, both
// actions in actions, and NO evaluators key (A3 owns the lifecycle, not A1).
test("memwalPlugin assembles the expected shape with no evaluators", () => {
  assert.equal(memwalPlugin.name, "plugin-memwal");
  assert.ok(memwalPlugin.services?.includes(MemwalService as never));
  const actionNames = (memwalPlugin.actions ?? []).map((a) => a.name);
  assert.deepEqual(actionNames, [MEMWAL_WRITE_CHECKPOINT, MEMWAL_READ_CHECKPOINT]);
  assert.ok(memwalPlugin.actions?.includes(writeCheckpointAction));
  assert.ok(memwalPlugin.actions?.includes(readCheckpointAction));
  assert.equal("evaluators" in memwalPlugin, false);
});
