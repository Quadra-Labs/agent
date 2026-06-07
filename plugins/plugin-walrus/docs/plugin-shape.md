# plugin-walrus — plugin shape and locked contracts (Phase 1, Task 1)

Design/contracts only. This document fixes the ElizaOS primitive mapping and the TypeScript
contracts that Task 2 (`walrusService.ts`) and Task 3 (`storeBlob.ts` / `readBlob.ts`) MUST
implement against. It introduces no service, action, provider, or test code. Source of truth for
signatures: `PHASE1_PLAN.md`. Phase scope: `GOAL.md:123-134`.

Phase 1 stores and reads **opaque bytes only**. No Seal, no MemWal, no job/template/Intake/signing
logic — those are Phases 2-5. Phase-2+ leakage (a `sealId`, MemWal metadata, job-template
assumptions) must not appear in any type or name here.

---

## 1. ElizaOS primitive mapping

The Walrus capability decomposes onto ElizaOS primitives as follows. The primitive interfaces
(`Service`, `Action`, `Provider`, `Content`, `HandlerCallback`) come from `@elizaos/core@1.7.2`.

### services — long-lived clients (Task 2, Task 5)
A single `walrusService` extends the core `Service` abstract class. It owns the long-lived clients
and is resolved through the runtime (`runtime.getService(...)`), never reconstructed per call.

- The service constructor / `start` builds **`SuiJsonRpcClient` + `WalrusClient` INSIDE the
  service**. It does NOT accept a pre-built generic Sui client from outside — that would force
  runtime type-detection of GraphQL vs JsonRpc and reopen the 5000B GraphQL trap. Only the
  **signer/keypair** is injected — and it is **optional**: `readBlob` needs no signer, `storeBlob`
  requires one. The key is never hardcoded; everything else is internalized.
- Exactly one `SuiJsonRpcClient` and one `WalrusClient` exist per service instance and are reused
  across every action call. Same-instance reuse is provable via `getService` returning the same
  reference across the store and read actions (gate item 4).
- The service exposes the typed `store` / `read` methods below and maps SDK outcomes to typed
  result `kind`s; it never returns `null` and never throws-through an expected blob-unavailable
  condition.

### actions — discrete ops (Task 3)
Two ElizaOS `Action`s, `WALRUS_STORE_BLOB` and `WALRUS_READ_BLOB`, each a thin delegate to the
service. An action handler returns a boolean-ish `ActionResult | void` and emits its real output by
calling the `HandlerCallback` with an ElizaOS `Content` object whose `data` carries the
`WalrusActionCallback` union below. Consumers/tests assert on **callback content**, not on the
handler return value.

### providers — context injection (Task 4)
One `Provider`, `walrusStatus`, reads **in-memory recently-stored handles from service state ONLY**
and surfaces them into agent context via `ProviderResult` (`text` / `values` / `data`). It is
read-only context injection: **no persistence, no indexing, no durability, no MemWal, no Seal**. If
this provider ever reaches for durable handle storage, that belongs to MemWal (Phase 3), not here —
cut it rather than grow it.

### evaluators — OUT of Phase 1 (explicit)
**Phase 1 declares NO evaluators.** Evaluators are post-interaction memory writes; they belong to
**Phase 3** (the memory model: session-checkpoint writes). Adding an evaluator in this plugin would
both leak Phase-3 concerns into the Walrus layer and violate the dependency chain (MemWal composes
Walrus, never the reverse). The Phase-1 `Plugin` object therefore omits `evaluators` entirely.

---

## 2. Locked TypeScript contracts

These are the exact shapes Tasks 2-3 implement. Kept in sync with `PHASE1_PLAN.md`: the plan carries
the phase-level version of these contracts; this section is the detailed Task-1 elaboration. Edit
both together — never let them diverge.

### 2.1 Action callback union (surfaced through `HandlerCallback`)

ElizaOS `HandlerCallback` is `(response: Content) => Promise<Memory[]>`, and `Content` carries a
`text` field plus open dynamic properties. The Walrus payload is a discriminated union placed on the
content's `data` field, e.g. `callback({ text: "...", data: <WalrusActionCallback> })`.

```ts
type WalrusActionCallback =
  | { type: "walrus.store.success"; blobId: string; blobObjectId?: string; sizeBytes: number; sha256: string }
  | { type: "walrus.read.success";  blobId: string; sizeBytes: number; sha256: string }
  | { type: "walrus.read.unavailable"; blobId: string; errorName: string; message: string }
  | { type: "walrus.error"; operation: "store" | "read"; errorName: string; message: string; retryable: boolean };
```

Rules:
- **Discriminator is `type` (the union tag), not `errorName`.** `errorName` is a free-form label
  only — do NOT pin it to a closed literal union of SDK class names. Observed names can change;
  P1.5 evidence saw `BlobNotCertifiedError`, but the doc and consumers must not hard-depend on it.
- The read-success callback carries `sha256` + `sizeBytes` as the assertion surface. **Do NOT inline
  the full blob bytes** (no `dataBase64`) into callback content — `sha256` is a complete correctness
  proof for the round-trip test.
- **The Phase-1 `readBlob` action is a retrievability/digest action**: it reports `blobId`,
  `sizeBytes`, and `sha256`, NOT inline content. Raw bytes are available at the **service layer**
  (`read()` returns `bytes`) for programmatic consumers (e.g. MemWal in Phase 3). Inline delivery
  (`dataBase64`) and a service-state read handle (`localReadHandle`) are both **deferred** — do not
  add either in Phase 1.
- Expected blob-unavailable is surfaced as the `walrus.read.unavailable` **value**, never a throw.
  Throws are reserved for programmer/config errors.

### 2.2 Service result types

The service constructs its own clients internally (see 2.3) and returns these typed results. Callers
**assert on `kind`**.

```ts
type WalrusReadResult =
  | { ok: true;  bytes: Uint8Array; blobId: string }
  | { ok: false; kind: "blob_unavailable"; blobId: string; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "network_error";   errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error";     errorName: string; message: string; retryable: false };

type WalrusStoreResult =
  | { ok: true;  blobId: string; blobObjectId?: string; sizeBytes: number }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error";  errorName: string; message: string; retryable: false };
```

Every error variant carries both `errorName` (a free-form label) and `message` (a
human-readable detail). The `message` is what Task 3 maps into the callback union's
`message` field, so actions never have to invent error text. `kind` stays the
discriminator.

Error-to-`kind` mapping (Task 2 implements this; do NOT add retry/backoff):
- Known Walrus blob errors (`BlobNotCertifiedError` / `BlobBlockedError`) -> `blob_unavailable`.
  Never `null`, never a throw-through. **Match on `err.constructor.name`, not `err.name`:** the
  `@mysten/walrus@1.1.7` error classes are anonymous class expressions that never set `this.name`, so
  an instance reports `.name === "Error"` while `.constructor.name` is the real class name. The
  classifier checks BOTH name candidates (constructor name and `.name`) so it is robust to either
  shape (e.g. DOMException aborts carry their kind in `.name`).
- Transient RPC / network failures -> `network_error`.
- Operation-time bad config -> `config_error`. The concrete Phase-1 case is **`store()` called on a
  service started without a signer** -> `config_error` ("signer required for store"). `read()` never
  needs a signer, so it has no signer-driven `config_error`. (Static config is validated earlier, at
  start time — see 2.3.)
- **Classifiable vs unclassifiable is the throw boundary.** If the failure can be classified
  (blob-unavailable / RPC-network / config) it becomes a typed result. If it **cannot** be
  classified, it **throws at the service layer** and should fail tests loudly — never coerce an
  unknown error shape into `network_error` (over-swallowing), nor throw on a recognized network
  timeout (over-throwing).
- `retryable` is **metadata only**. Phase 1 implements NO retry/backoff machinery anywhere. A
  consumer asserting on `kind` is correct; a consumer branching on `retryable` to drive retries is
  out of scope for Phase 1.

Callback mapping (Task 3 translates service result -> callback union):
- `WalrusStoreResult.ok` -> `walrus.store.success`.
- `WalrusReadResult.ok` -> `walrus.read.success`.
- `WalrusReadResult` `kind: "blob_unavailable"` -> `walrus.read.unavailable`.
- Any `network_error` / `config_error` result -> `walrus.error` with the matching `operation`.

### 2.3 Service config (construct clients internally)

The service builds `SuiJsonRpcClient` + `WalrusClient` itself in its static `start` lifecycle. It
does NOT accept a pre-built generic Sui client from outside. Callers pass **input** config (defaults
optional); the service **normalizes** it once at start.

```ts
type WalrusServiceConfigInput = {
  suiRpcUrl: string;
  network: "testnet";
  signer?: Signer;       // OPTIONAL: readBlob needs none; storeBlob requires it. Never logged.
  epochs?: number;       // default 3
  deletable?: boolean;   // default false
};

type NormalizedWalrusServiceConfig = {
  suiRpcUrl: string;
  network: "testnet";
  signer?: Signer;       // still optional after normalization (read-only services are allowed)
  epochs: number;        // normalized: defaults to 3
  deletable: boolean;    // normalized: defaults to false
};
```

Rules:
- Defaults applied during normalization: `epochs: 3`, `deletable: false`. **`epochs` is rejected
  below 3** (`epochs: 1` expired at the epoch boundary in P0b; 3 is the proven safe testnet minimum) —
  an out-of-range value throws `WalrusConfigError` at start, with no network I/O. `deletable` is a
  **required** `writeBlob()` field with no SDK default, so the service always passes the **normalized
  `deletable`** explicitly (default `false`; an explicit `deletable: true` in config is honored).
- `signer` is **optional**. The key is loaded out-of-band (e.g. via `sui keytool export`), injected
  as a `Signer`, and must **never be logged**. A service with no signer is a valid read-only service.

**Two-tier `config_error` (this is the only correct model — a constructor cannot return a result):**
- **Start-time / static config** (malformed `suiRpcUrl`, wrong `network`, out-of-range `epochs`):
  `WalrusService.start(runtime)` validates it with **no network I/O** and **throws** a typed
  `WalrusConfigError` whose `kind` is `"config_error"`. This is gate item 9's assertion target (a
  non-live unit test). The throw and the result share the discriminator:

  ```ts
  class WalrusConfigError extends Error {
    readonly kind = "config_error";
  }
  ```

- **Operation-time config** (signer-dependent): a service started **without a signer** can still
  `read()`, but `store()` returns a `config_error` **result** ("signer required for store"). This is
  also non-live-testable (no network needed) and is why `config_error` stays in `WalrusStoreResult`.

### Method signatures Tasks 2-3 must expose

```ts
// walrusService (Task 2) — long-lived, resolved via runtime.getService
store(bytes: Uint8Array): Promise<WalrusStoreResult>; // config_error result if started without a signer
read(blobId: string): Promise<WalrusReadResult>;      // no signer required
```

Reference SDK call shapes ported from the spike (`phase0/spike/p1_walrus_roundtrip.mjs`):
`walrusClient.writeBlob({ blob, epochs, deletable, signer })` returns `{ blobId, blobObject }` (use
`blobObject?.id` for `blobObjectId`; `epochs`/`deletable` are the normalized config values, default
`3`/`false`); `walrusClient.readBlob({ blobId })` returns the bytes.

---

## 3. Build-config note (carry forward)

This package uses **`moduleResolution: Bundler` + `module: ESNext`** (NOT NodeNext), per
`tsconfig.json`. `@elizaos/core@1.7.2` does not resolve under NodeNext: its `exports["."]` lists the
`types` condition first and the typedef tree uses extensionless relative re-exports, so
`Plugin` / `Action` / `Provider` / `Service` fail to surface (`TS2305`). Its types are authored for
Bundler resolution. Do not revert to NodeNext.

Known expected type friction (port-from notes): `@mysten/walrus@1.1.7` wants `ClientWithCoreApi`;
`SuiJsonRpcClient` satisfies it at runtime (exposes `.core` + `.cache`) but the TS types complain —
resolve with a documented cast, never by switching to `SuiGraphQLClient`. Import
`SuiJsonRpcClient` from `@mysten/sui/jsonRpc`.

---

## 4. Out of Phase 1 (guard against scope creep)

- No Seal, no MemWal, no job/template/Intake/signing/wallet-handshake logic, and no `sealId` or
  MemWal metadata in any type or name.
- No evaluators (Phase 3).
- No retry/backoff machinery (`retryable` is metadata only).
- No persistence/indexing/durability in `walrusStatus` (in-memory handles only).
- No cross-workstream locks are required to reach the Phase-1 gate; Phase 1 stores opaque bytes.
