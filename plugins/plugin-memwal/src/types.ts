// plugin-memwal contracts (types only). The encrypt/decrypt seam is pluggable plain
// function hooks: an EMPTY seam is plain/demo mode, a present pair is prod — it stays
// Seal-agnostic (no Seal symbol may appear here). Error `kind` names mirror
// plugin-walrus's result unions so a Walrus failure can map straight through.

/**
 * The condensed session record stored as a blob and recalled on resume:
 * roomId/createdAt/turnCount/summary + the (user, agent, session) index-key triple.
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
