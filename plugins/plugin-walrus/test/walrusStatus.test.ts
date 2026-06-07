// Non-live tests for the WALRUS_STATUS provider (Phase 1, Task 4).
//
// These drive walrusStatusProvider.get directly with a STUB runtime (a plain
// object cast to IAgentRuntime) — no ElizaOS runtime harness, no network. The
// provider only calls runtime.getService(...) and reads recentHandles(), so the
// stub is cheap and fully covers the three branches: missing service, empty ring,
// and a populated ring (including the TEXT_HANDLE_LIMIT prose cap).
//
// NOT covered here (deliberately deferred to the live Task 6a/6b path): the real
// WalrusService.recentHandles() accessor returning per-handle COPIES. Exercising
// that with a non-empty ring would require a live store() or a test-only mutator,
// and the design explicitly forbids a public/test mutator on the service. The
// pure recordHandle tests already prove the ring's order, bound, and non-mutation.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { IAgentRuntime, Memory, State } from "@elizaos/core";

import { walrusStatusProvider } from "../src/walrusStatus.js";
import type { StoredBlobHandle } from "../src/types.js";

// Minimal handle factory — only the fields the provider reads need to be distinct.
const mk = (n: number): StoredBlobHandle => ({
  blobId: `blob-${n}`,
  blobObjectId: `obj-${n}`,
  sizeBytes: n,
  storedAtMs: 1000 + n,
});

// A stub runtime whose getService returns whatever `service` we pass (null to
// simulate an unresolved service). Cast through unknown — the provider only ever
// calls getService, so nothing else needs to exist.
const runtimeWith = (service: unknown): IAgentRuntime =>
  ({ getService: () => service } as unknown as IAgentRuntime);

// A stub service exposing just recentHandles(), as the provider consumes it.
const serviceWith = (handles: readonly StoredBlobHandle[]): unknown => ({
  recentHandles: () => handles,
});

const emptyMessage = {} as unknown as Memory;
const emptyState = {} as unknown as State;

// Case 1 — getService returns null -> graceful placeholder, never throws.
test("missing service -> graceful empty result", async () => {
  const result = await walrusStatusProvider.get(runtimeWith(null), emptyMessage, emptyState);
  assert.equal(result.values?.walrusRecentCount, 0);
  assert.deepEqual(result.data?.recentHandles, []);
});

// Case 2 — service present but the ring is empty -> graceful empty result.
test("service present, no handles -> graceful empty result", async () => {
  const result = await walrusStatusProvider.get(
    runtimeWith(serviceWith([])),
    emptyMessage,
    emptyState,
  );
  assert.equal(result.values?.walrusRecentCount, 0);
  assert.deepEqual(result.data?.recentHandles, []);
  assert.equal(result.text, "No blobs have been stored on Walrus yet.");
});

// Case 3 — 6 handles (newest-first) proves the TEXT_HANDLE_LIMIT=5 prose cap:
// text lists only the newest 5 + an "...and 1 more." line, while data/values
// carry the full set.
test("6 handles -> text caps at 5 + overflow line; data/values carry all 6", async () => {
  // Newest-first, as the service would return it: blob-6 is the latest.
  const handles = [mk(6), mk(5), mk(4), mk(3), mk(2), mk(1)];
  const result = await walrusStatusProvider.get(
    runtimeWith(serviceWith(handles)),
    emptyMessage,
    emptyState,
  );

  // values: full count + newest blobId.
  assert.equal(result.values?.walrusRecentCount, 6);
  assert.equal(result.values?.walrusLatestBlobId, "blob-6");

  // data: the complete set (all 6), not just the shown ones.
  assert.equal((result.data?.recentHandles as StoredBlobHandle[]).length, 6);

  // text: newest 5 shown, oldest (blob-1) elided behind the overflow line.
  const text = result.text ?? "";
  assert.ok(text.includes("blob-6"));
  assert.ok(text.includes("...and 1 more"));
  assert.ok(!text.includes("blob-1"));
});
