# PHASE1_PLAN.md — Walrus plugin (clean)

Locked plan for **Phase 1** of the Agent Framework workstream (GOAL.md:123-134). Written before
Task 1 implementation so the exit gate and the data contracts do not drift once code starts. The
Phase-0 spike (the proven reference to port from) lives under `phase0/`.

Scope, verbatim from GOAL.md: turn the proven Walrus spike into real, structured code — a long-lived
`walrusService`, `storeBlob`/`readBlob` actions, a `walrusStatus` provider, and an isolated test.
Phase 1 stores and reads **opaque bytes only**. No Seal, no MemWal, no job/template/Intake/signing
logic — those are Phases 2-5.

---

## Locked exit gate (stricter than the planner's first draft)

GOAL.md's gate says the agent stores AND retrieves blobs **via the plugin transparently**, with a
passing isolated test. "Via the plugin" is load-bearing: a service-direct-only test does NOT satisfy
it. The gate passes only when ALL of the following have evidence:

1. The Walrus **service** stores and reads bytes on **real Walrus testnet** (live).
2. A fake/missing blob ID returns a **typed `blob_unavailable` result** — asserted at BOTH the
   service layer and the plugin/action layer — never `null`, never a thrown-through crash.
3. The plugin exports a **valid ElizaOS `Plugin`** object.
4. `storeBlob`/`readBlob` actions invoke the **same long-lived service instance** — proven via the
   runtime's `getService` returning the same reference across both calls (NOT a constructor counter;
   no test-only instrumentation in production code).
5. Action results are surfaced through **`HandlerCallback` content** (the locked union below), not a
   bare return value.
6. Plugin-path test: store -> read -> **SHA-256 match** verified from the callback's `sha256`.
7. Plugin-path fake-id test surfaces the **typed unavailable callback** (`walrus.read.unavailable`).
8. **No** Seal / MemWal / job-template / Intake / signing / wallet-handshake logic appears anywhere
   in Phase 1.
9. **Bad config fails fast.** Static config: `WalrusService.start` throws a typed `WalrusConfigError`
   (`kind: "config_error"`) with no network I/O. Operation-time: `store()` on a service started
   without a signer returns a `config_error` result. Both are non-live unit tests.

Live vs offline: gate items 1, 2 (network path), 6, 7 require `WALRUS_LIVE=1` + a funded signer.
Items 3, 4, 5, 9 run with `WALRUS_LIVE` unset (no wallet) and are the CI-safe coverage.

---

## Locked data contracts (design these in Task 1, before any action code)

### Action callback union (surfaced through `HandlerCallback`)
ElizaOS action handlers return a boolean and emit real output through a `HandlerCallback`, so the
test asserts on **callback content**, not a return value. The payload is a discriminated union and
must live inside a valid ElizaOS `Content` object (which carries a `text` field), e.g.
`callback({ text: "...", data: <WalrusActionCallback> })`.

```ts
type WalrusActionCallback =
  | { type: "walrus.store.success"; blobId: string; blobObjectId?: string; sizeBytes: number; sha256: string }
  | { type: "walrus.read.success";  blobId: string; sizeBytes: number; sha256: string }
  | { type: "walrus.read.unavailable"; blobId: string; errorName: string; message: string }
  | { type: "walrus.error"; operation: "store" | "read"; errorName: string; message: string; retryable: boolean };
```

Rules:
- The **discriminator is `type`/`kind`**, not `errorName`. `errorName` is a free-form label only —
  do not pin it to a closed literal union of SDK class names (verify actual names against
  `phase0/spike-evidence/P1_5-walrus-hardening.md`; they can change).
- The read-success callback carries `sha256` + `sizeBytes` as the assertion surface. The Phase-1
  `readBlob` action is a **retrievability/digest action** — it reports `blobId`/`sizeBytes`/`sha256`,
  NOT inline content. Raw bytes are available at the **service layer** (`read()` returns `bytes`) for
  programmatic consumers (MemWal, Phase 3). **Do NOT inline the full blob bytes** (`dataBase64`) and
  do not add a `localReadHandle` in Phase 1 — both are deferred. `sha256` is a complete correctness
  proof for the test.
- Expected blob-unavailable is the `walrus.read.unavailable` **value, not a throw**. Throws are
  reserved for programmer/config errors.

### Service result types
The service constructs its own clients internally (see config rule) and returns typed results:

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

Rules:
- Assert on **`kind`**. Map known Walrus errors to a kind
  (`BlobNotCertifiedError`/`BlobBlockedError` -> `blob_unavailable`; transient RPC/network ->
  `network_error`; operation-time signer-missing on `store()` -> `config_error`). The throw boundary
  is **classifiable vs unclassifiable**: a classifiable failure becomes a typed result; an
  **unclassifiable** error **throws at the service layer** (fail tests loudly) and must NOT be coerced
  into `network_error`, nor may a recognized network timeout be thrown instead of mapped.
- **Classify on `err.constructor.name`, not `err.name`.** The `@mysten/walrus@1.1.7` error classes
  are anonymous class expressions that never set `this.name` (instances report `.name === "Error"`),
  so an `err.name`-only match silently misses every blob error and throws-through. The classifier
  checks both name candidates (constructor name and `.name`) to stay robust.
- Every error variant carries `message` (human-readable) alongside `errorName` (free-form label), so
  Task 3 can populate the callback union's `message` without inventing text.
- `retryable` is **metadata only**. Phase 1 implements NO retry/backoff machinery.

### Service config (construct clients internally — kills the GraphQL trap structurally)
The service builds `SuiJsonRpcClient` + `WalrusClient` **itself** in its static `start` lifecycle. It
does NOT accept a pre-built generic Sui client from outside (which would force runtime type-detection
of GraphQL vs JsonRpc). Callers pass **input** config (defaults optional); the service **normalizes**
it once at start.

Input fields: `suiRpcUrl`, `network` (`testnet`), `signer?` (**optional** — `readBlob` needs none,
`storeBlob` requires it; never logged), `epochs?` (default **3**, **rejected below 3** — 3 is the
proven safe testnet minimum), `deletable?` (default **false**). Normalization fills `epochs`/
`deletable` and the service passes the normalized `deletable` to `writeBlob` explicitly (no SDK
default); `signer` stays optional (read-only services allowed).

`config_error` is **two-tier** (a constructor cannot return a result):
- **Start-time / static config** (bad `suiRpcUrl`/`network`, or `epochs` not an integer >= 3):
  `WalrusService.start` throws a typed `WalrusConfigError` (`readonly kind = "config_error"`), no
  network I/O. Gate item 9.
- **Operation-time** (signer-dependent): `store()` without a signer returns a `config_error` result;
  `read()` needs no signer. This is why `config_error` remains in `WalrusStoreResult`.

---

## Task order

| # | Task | Done = | Ports from |
|---|------|--------|------------|
| 0 | Scaffold package | DONE — ESM TS package installs + `tsc --noEmit` clean on a `Plugin`-typed stub | spike `package.json` versions |
| 1 | Document plugin shape + lock the contracts above | callback union + service result/config types fixed in a design doc; evaluators declared out-of-Phase-1 | P1/P1.5 call shapes |
| 2 | `walrusService.ts` (long-lived client) | one `SuiJsonRpcClient`+`WalrusClient` built internally, reused; normalized `deletable` (default false) + `epochs>=3`; known errors -> typed `kind` (classify on `constructor.name`), unexpected -> throw; config validation; non-live classifier test | `phase0/spike/p1_walrus_roundtrip.mjs`, `p1_5_walrus_hardening.mjs` |
| 3 | `storeBlob.ts` / `readBlob.ts` actions | two ElizaOS Actions delegating to the service; convert typed result -> callback union; return boolean | spike runtime wiring |
| 4 | `walrusStatus.ts` provider | surfaces in-memory recently-stored handles from service state ONLY (no persistence, no MemWal, no Seal) | `phase0/spike/eliza_standalone/p3_C_memwal_on_answer.mjs` injection pattern |
| 5 | Assemble `Plugin`, service long-lived via runtime lifecycle | single `Plugin` export; service via `getService`, not per-action construction | `phase0/spike/eliza_standalone/eliza_standalone.mjs` |
| 6a | Service live test | service store/read/fake-id against real testnet; SHA-256 match; fake id -> `blob_unavailable` | `p1_5` assertions |
| 6b | Plugin integration test (the gate) | load Plugin -> register service -> **resolve action objects, call handlers directly** with minimal runtime + message + callback (NO LLM loop); assert callback `sha256` match + fake-id typed unavailable (`walrus.read.unavailable`) + same service instance across both actions | gate items 3-7 |

Task 1 lands before Task 3 touches an action. Task 6b is deterministic: resolve the registered
action and call its handler — never drive a model message-loop (that would test the LLM's action
selection, not the plugin).

---

## Reviewer / exit-gate traps

- **Wrong Sui client.** Must be `SuiJsonRpcClient` (JsonRpc), never `SuiGraphQLClient` (5000B query
  limit breaks Walrus). Solved structurally by constructing the client inside the service. The TS
  type complaint about `ClientWithCoreApi` is expected — confirm a documented cast, not a switch to
  GraphQL.
- **Silent null / throw-through on missing blob.** Must map to a typed `blob_unavailable`. Classify
  on `err.constructor.name` (the SDK's blob errors are anonymous classes with `.name === "Error"`) —
  an `err.name`-only match throws-through and fails this trap.
- **Missing/wrong store params.** `deletable` always passed explicitly (no SDK default; normalized,
  default `false`); `epochs >= 3` (epochs=1 expired at the boundary in P0b).
- **Service not actually long-lived.** A new client per action call violates the service mapping.
  Prove single instance via `getService`.
- **Test only exercises the service.** The gate requires the **plugin/action path** (6b), not just
  `walrusService` directly (6a). 6a passing + 6b failing = Phase 1 NOT done.
- **Mock-only test.** A purely mocked test never demonstrates the gate; the canonical pass is a live
  round-trip.
- **Phase 2+ leakage.** No `sealId`, no MemWal metadata, no job-template assumptions in any type or
  name. `walrusStatus` must not grow persistence/indexing — if it reaches for durability, cut it
  (a durable handle index leans toward MemWal, not this plugin).
- **Secret hygiene.** Key loaded via `sui keytool export` must never be logged.

---

## Build-config note (carry forward to all Phase-1 tasks)

`@elizaos/core@1.7.2` does NOT resolve under `moduleResolution: NodeNext` — its `exports["."]` lists
the `types` condition first and the typedef tree uses extensionless relative re-exports, so
`Plugin`/`Action`/`Provider`/`Service` fail to surface (`TS2305`). The package's types are authored
for **Bundler** resolution. Phase 1 uses `moduleResolution: Bundler` + `module: ESNext` (still fully
ESM). Do not revert to NodeNext. (Recorded in memory: elizaos-standalone-gotchas.)

---

## Cross-workstream locks — status for Phase 1

None of the four locks (job template schema, job submission/response payload, job request schema,
Intake handshake) are needed to reach the Phase-1 gate — Phase 1 stores opaque bytes. No task here is
blocked. Starting those lock conversations is a human action for later, not a Phase-1 coding task.

---

## Live-test budget (practical)

6a/6b write real blobs to testnet on every run; the spike wallet (`interesting-axinite` /
`0x0988...`) had ~0.44 SUI and the faucet was rate-limited. Run the non-live suite (config, plugin
load, action wiring, service identity) freely with `WALRUS_LIVE` unset; run the live round-trip
deliberately, with tiny payloads and `epochs: 3`. "The test passes" must not quietly mean "we drained
the wallet doing it."
