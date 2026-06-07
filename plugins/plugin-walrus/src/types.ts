// Locked Phase-1 contracts. Source of truth: PHASE1_PLAN.md (section "Locked
// data contracts") and docs/plugin-shape.md (section 2). Keep this file in sync
// with both. Phase 1 stores/reads OPAQUE BYTES ONLY — no Seal, MemWal, job,
// template, Intake, or signing concepts may appear here.

import type { Signer } from "@mysten/sui/cryptography";

// --- Action callback union (surfaced through HandlerCallback) -----------------
// The discriminated payload the Task-3 actions place on a Content's `data` field,
// e.g. callback({ text, data: <WalrusActionCallback> }). `type` is the
// discriminator (NOT errorName, which is a free-form label). Tests assert on this
// callback content, never on the handler's return value. readBlob is a
// retrievability/digest action: it reports blobId/sizeBytes/sha256, NOT inline
// bytes (raw bytes stay at the service layer for Phase-3 consumers).
export type WalrusActionCallback =
  | { type: "walrus.store.success"; blobId: string; blobObjectId?: string; sizeBytes: number; sha256: string }
  | { type: "walrus.read.success"; blobId: string; sizeBytes: number; sha256: string }
  | { type: "walrus.read.unavailable"; blobId: string; errorName: string; message: string }
  | { type: "walrus.error"; operation: "store" | "read"; errorName: string; message: string; retryable: boolean };

// --- Service result types (callers assert on `kind`) -------------------------

// Error result variants carry `message` (a human-readable detail) alongside the
// free-form `errorName` label, so the Task-3 actions can populate the callback
// union's `message` field without inventing text. `kind` stays the discriminator.
export type WalrusReadResult =
  | { ok: true; bytes: Uint8Array; blobId: string }
  | { ok: false; kind: "blob_unavailable"; blobId: string; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false };

export type WalrusStoreResult =
  | { ok: true; blobId: string; blobObjectId?: string; sizeBytes: number }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false };

// --- Service config ----------------------------------------------------------
// The service builds SuiJsonRpcClient + WalrusClient ITSELF in its static start
// lifecycle. It never accepts a pre-built generic Sui client (that would reopen
// the GraphQL 5000B trap). Callers pass input config; the service normalizes it
// once. `signer` is optional: read() needs none, store() requires it.

export type WalrusServiceConfigInput = {
  suiRpcUrl: string;
  network: "testnet";
  signer?: Signer; // OPTIONAL: read needs none, store requires it. Never logged.
  epochs?: number; // default 3
  deletable?: boolean; // default false
};

export type NormalizedWalrusServiceConfig = {
  suiRpcUrl: string;
  network: "testnet";
  signer?: Signer; // still optional after normalization (read-only services allowed)
  epochs: number; // normalized: defaults to 3
  deletable: boolean; // normalized: defaults to false
};

// --- Service-owned recently-stored handle (Task 4) ---------------------------
// In-memory metadata the service self-records after a successful store(), read
// back by the walrusStatus provider. Service state ONLY — there is NO
// action->service write path and NO persistence/indexing (that would lean toward
// MemWal, which is Phase 3). All fields are primitives, so a shallow copy fully
// isolates a handle. Deliberately NO sha256 here: sha256 is action-callback /
// test metadata and never enters service state. Phase 1 is opaque bytes only —
// no Seal / MemWal / job / template / Intake / Phase-2+ identifiers.
export type StoredBlobHandle = {
  blobId: string;
  blobObjectId?: string;
  sizeBytes: number;
  storedAtMs: number;
};
