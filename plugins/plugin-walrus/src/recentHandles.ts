// recentHandles.ts — pure, network-free helper that maintains the service's
// bounded, newest-first ring of recently-stored blob handles (Phase 1, Task 4).
//
// WHY this is extracted (mirrors errorClassification.ts):
//   The ring is otherwise only populated as a side effect of a LIVE store() —
//   which writes a real blob to Walrus testnet and needs a funded signer. A
//   non-live CI test therefore cannot exercise the ring's ordering and bound
//   through the service at all. Pulling the ring update into a pure function (no
//   @elizaos/core, no WalrusClient, no network) lets a deterministic unit test
//   prove newest-first ordering, the max bound, and non-mutation of the input —
//   exactly the way the error classifier was made unit-testable in isolation.
//
// Phase 1 is opaque bytes only: no Seal / MemWal / job / template / Intake /
// Phase-2+ identifiers appear here.

import type { StoredBlobHandle } from "./types.js";

// Prepend `handle` as the newest entry and return a NEW readonly array bounded to
// `max` (oldest entries beyond the bound are dropped). The input `ring` is NEVER
// mutated in place — a fresh array is always built — so the service can treat its
// stored ring as immutable and simply reassign the result. `max <= 0` yields an
// empty ring.
export function recordHandle(
  ring: readonly StoredBlobHandle[],
  handle: StoredBlobHandle,
  max: number,
): readonly StoredBlobHandle[] {
  if (max <= 0) return [];
  // Newest-first: the new handle leads, then the previous entries in order.
  // [handle, ...ring] builds a brand-new array; `ring` itself is untouched.
  return [handle, ...ring].slice(0, max);
}
