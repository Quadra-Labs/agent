// sha256.ts — SHA-256 digest helper for the Phase-1 action callbacks.
//
// The store/read actions report a `sha256` over the blob bytes; the gate test
// proves a round-trip by matching the store-side digest against the read-side
// digest (PHASE1_PLAN.md gate item 6). sha256 is a complete correctness proof,
// which is why the read callback carries the digest instead of inlining bytes.
//
// node:crypto (synchronous, no DOM BufferSource generics) keeps this trivial and
// deterministic; the plugin already runs on the Node-based ElizaOS runtime.

import { createHash } from "node:crypto";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
