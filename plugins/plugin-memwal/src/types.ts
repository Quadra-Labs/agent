// A1 plugin-memwal — locked MemWal contracts (types only). PLAIN mode: NO Seal.
// The encrypt/decrypt seam here is a pair of pluggable plain function hooks; an
// EMPTY seam (both undefined) is the valid default (demo/plain mode) and a present
// pair is prod mode. The seam must stay Seal-agnostic: no Seal type, SessionKey,
// packageId, or policyId may appear in this file. The actual Seal-backed seam
// implementation is A2 and is out of scope here.
//
// MemWal composes Walrus (dependency direction MemWal -> Walrus); these types are
// plain TS and import neither the Walrus nor the Seal service. The error `kind`
// names mirror plugin-walrus's result unions so a later task can map the underlying
// Walrus failure straight through.

/**
 * The condensed session record stored as a blob and recalled on resume. Lifts the
 * demo's `Checkpoint` JSON shape (roomId/createdAt/turnCount/summary) and extends
 * it with the index-key fields so the index can resolve (user, agent, session).
 */
export interface Checkpoint {
  readonly roomId: string;
  readonly createdAt: number;
  readonly turnCount: number;
  readonly summary: string;
  // Index-key fields: the (user, agent, session) triple the index resolves on.
  readonly user: string;
  readonly agent: string;
  readonly session: string;
}

/**
 * The pluggable encrypt seam: OPTIONAL plain byte-transform hooks. Both absent is
 * the valid default (plain mode); a present pair is prod mode. These are plain
 * function hooks only — they intentionally reference no Seal symbol. Whatever
 * supplies them (A2) owns that concern; MemWal only ever sees bytes in, bytes out.
 */
export interface MemwalSeam {
  readonly encrypt?: (bytes: Uint8Array) => Promise<Uint8Array>;
  readonly decrypt?: (bytes: Uint8Array) => Promise<Uint8Array>;
}

// --- Service result types (callers assert on `kind`) -------------------------
// Mirrors plugin-walrus's `ok: true | { ok: false; kind; errorName; message;
// retryable }` style. The Walrus-facing error kinds (network_error /
// blob_unavailable / config_error) reuse Walrus's kind names so the underlying
// failure maps through; `invalid_checkpoint` is the MemWal-specific kind for a
// blob that read back but was malformed/unparseable.

// `indexed` (ok:true only) is ADDITIVE/OPTIONAL extra info on success — NOT a new
// outcome. The blob's durability is the contract: an index-write failure still
// returns ok:true with the blobId (the blob IS on Walrus). `indexed` reports
// whether the (user, agent[, session]) -> blobId index entry was also recorded:
// true = recorded, false = skipped/failed (no runtime/index, or index.record
// threw) so recall-by-index may not find this blob. Existing callers that ignore
// it compile and behave unchanged.
export type WriteCheckpointResult =
  | { ok: true; blobId: string; indexed?: boolean }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false };

export type ReadCheckpointResult =
  | { ok: true; checkpoint: Checkpoint }
  | { ok: false; kind: "blob_unavailable"; blobId: string; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "invalid_checkpoint"; blobId: string; errorName: string; message: string; retryable: false };
