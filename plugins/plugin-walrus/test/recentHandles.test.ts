// Non-live deterministic tests for the recently-stored handle ring (Phase 1,
// Task 4).
//
// WHY this exists: the ring is otherwise populated only as a side effect of a
// LIVE store() (a real Walrus testnet write needing a funded signer), so a
// non-live CI run cannot exercise its ordering or bound through the service. The
// pure recordHandle helper is testable in isolation — no network, no service
// construction, no WalrusClient. These tests guard the three invariants the
// provider depends on: newest-first ordering, the max bound (oldest dropped),
// and non-mutation of the input ring (a fresh array is always returned).

import { test } from "node:test";
import assert from "node:assert/strict";

import { recordHandle } from "../src/recentHandles.js";
import type { StoredBlobHandle } from "../src/types.js";

// Minimal handle factory — only the fields under test need to be distinct.
const mk = (n: number): StoredBlobHandle => ({
  blobId: `blob-${n}`,
  blobObjectId: `obj-${n}`,
  sizeBytes: n,
  storedAtMs: 1000 + n,
});

// (a) Newest-first ordering across several recordHandle calls.
test("recordHandle keeps newest-first order across calls", () => {
  let ring: readonly StoredBlobHandle[] = [];
  ring = recordHandle(ring, mk(1), 20);
  ring = recordHandle(ring, mk(2), 20);
  ring = recordHandle(ring, mk(3), 20);

  assert.deepEqual(
    ring.map((h) => h.blobId),
    ["blob-3", "blob-2", "blob-1"],
  );
});

// (b) The bound is enforced: push more than max, length caps at max and the
// OLDEST entries are dropped (newest are retained).
test("recordHandle enforces the max bound and drops the oldest", () => {
  const max = 3;
  let ring: readonly StoredBlobHandle[] = [];
  for (let i = 1; i <= 6; i += 1) {
    ring = recordHandle(ring, mk(i), max);
  }

  assert.equal(ring.length, max);
  // The three newest survive (6,5,4); the oldest (1,2,3) were dropped.
  assert.deepEqual(
    ring.map((h) => h.blobId),
    ["blob-6", "blob-5", "blob-4"],
  );
});

// (c) The input ring is NOT mutated and a NEW reference is returned. Freeze the
// input so any in-place mutation (push/unshift/splice) would throw, and capture
// its contents to assert they are unchanged.
test("recordHandle does not mutate the input ring and returns a new reference", () => {
  const original: readonly StoredBlobHandle[] = Object.freeze([mk(1), mk(2)]);
  const before = original.map((h) => h.blobId);

  const next = recordHandle(original, mk(3), 20);

  // A fresh array reference is returned.
  assert.notEqual(next, original);
  // The original is untouched (contents and length).
  assert.equal(original.length, 2);
  assert.deepEqual(
    original.map((h) => h.blobId),
    before,
  );
  // ...and the new array has the new handle at the front.
  assert.equal(next[0]?.blobId, "blob-3");
  assert.equal(next.length, 3);
});

// Edge — max <= 0 yields an empty ring without touching the input.
test("recordHandle with max <= 0 returns an empty ring", () => {
  const original: readonly StoredBlobHandle[] = Object.freeze([mk(1)]);
  const next = recordHandle(original, mk(2), 0);
  assert.equal(next.length, 0);
  assert.equal(original.length, 1);
});
