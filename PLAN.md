# PLAN.md — Agent Framework: the actual build plan

> Single authoritative plan (2026-06-08). Supersedes `PHASE1_PLAN.md` (Walrus, DONE) and
> `PHASE2_PLAN.md` (Seal — reframed: I now *consume* a teammate's contract, not author it).
> Scope per `GOAL.md`. Two tracks: **(A) the framework** (production-grade), **(B) the demo**
> (separate `demo/` folder, runnable from one API key). The demo reuses what the framework
> builds; it does not fork it.

## Where things stand
- **plugin-walrus — DONE.** Store/read opaque blobs on Walrus; tested; live gate met.
- **plugin-seal — scaffold only.** The hard part (the option-3 / per-(user, agent) Move
  policy) was **proven on testnet** in `phase0/spike/task1_bysender/`. That spike is now the
  **contract spec handed to the teammate who owns Seal**, not code I keep iterating. What
  stays mine is the *client-side* integration that calls their deployed contract.
- **plugin-memwal — not started.**
- **agent app + demo — not started** (no `apps/` yet).

---

## Track A — the framework

### A1. plugin-memwal — checkpoint store on Walrus (no Seal yet)
Compose plugin-walrus. The unit of storage is a **session checkpoint** (a condensed summary
blob), not raw chat.
- `memwalService.ts` — `writeCheckpoint(checkpoint) -> { blobId }`, `readCheckpoint(blobId) ->
  checkpoint`. Uses `walrusService` for the bytes; **never** the reverse.
- Encryption is a **pluggable seam** (`encrypt?/decrypt?` hooks): absent = plain (demo),
  present = Seal (prod). Keep MemWal runnable with the seam empty.
- A small **checkpoint index** (which `(user, agent, session)` maps to which `blobId`) so a new
  session can find prior checkpoints. Local/SQLite-backed for now.
- **Done:** write a checkpoint → read it back byte-faithful through the plugin; index resolves
  `(user, agent)` → its checkpoint blob(s).

### A2. plugin-seal — client integration against the teammate's contract
- `sealService.ts` — `encrypt(bytes, policyId) -> cipher`, `decrypt(cipher, sessionKey) ->
  bytes`, building the `seal_approve` PTB for the **external** `packageId` + policy object.
- Port the proven client shapes from the spike (SessionKey lifecycle, clock-skew backdate,
  error classification: `no_access` vs `session_error` vs `invalid_ciphertext`). Reuse the
  memories `seal-testnet-gotchas`, `seal-id-binds-access`, `seal-client-key-cache`.
- **Blocked on the Seal lock** (contract interface from the teammate). Until then this stays a
  thin, typed seam that MemWal can call once the contract exists.
- **Done:** byte-exact encrypt→decrypt round-trip against the deployed contract; a non-bound
  party gets a typed `no_access`. Wire it as MemWal's `encrypt/decrypt` hooks.

### A3. agent app — runtime, chat memory, checkpoint lifecycle
Reuse the proven standalone boot (`phase0/spike/eliza_standalone/eliza_standalone.mjs`):
`@elizaos/core` `AgentRuntime` + `@elizaos/plugin-sql` (the local DB / "SQLite") +
`@elizaos/plugin-groq` (LLM) + `plugin-walrus` + `plugin-memwal`, with manual migration
bootstrap and config via `character.settings`.
- **Live chat → SQLite:** rely on the runtime's built-in message memory (plugin-sql). Confirm
  turns persist and are recalled into context.
- **Checkpoint writer:** condense the session and write to MemWal on **session-leave AND a
  session-length limit** (not per message). Driven from a session-lifecycle hook, not a
  per-interaction evaluator (per-message writes would burn gas).
- **Checkpoint recall:** at the start of a new `(user, agent)` session, look up prior
  checkpoint(s) via the index and inject them into context.
- **Done:** memory survives across sessions — close a session, start a new one, the agent
  continues with the recalled checkpoint.

### A4. agent framework — job-template matching + parameter collection
- **Template provider:** read the category's job templates (a Walrus object) and inject them
  into context. Templates carry `category_id`, `job_template { output, lifetime }`, plus
  agent-facing `title` + `params` (the questions to ask).
- **Matching + confirmation:** when the user describes a job, the agent matches a template and
  asks *"is this the job you're describing?"* — naturally, **not** by printing the template.
- **Parameter collection:** the agent asks for each `params` entry conversationally and tracks
  what is still missing until the job intent is complete.
- **Outbound Intake notification (constructed, not signed):** build the
  `{ user_wallet, job_template, job_id, agent_id }` message on confirmation. The auth/signing
  channel is the Intake side's — here it is stubbed/logged.
- **Done:** a full chat where the agent matches, confirms, and collects all parameters for a
  template, then emits the (stub) Intake notification.

---

## Track B — the demo (`demo/`, separate folder)
A standalone terminal app. **A teammate puts one `GROQ_API_KEY` in `demo/.env` and runs it** —
nothing else. Self-contained so the user can publish it to GitHub on its own. **I do not push.**

- **`demo/README.md`** — what it shows + exact run steps + the `.env.example` (`GROQ_API_KEY`).
- **Terminal REPL:** user types, agent responds (Groq).
- **Inspect SQLite:** a command (e.g. `/history`) that prints what the chat wrote to the local
  DB — so the user literally sees the SQLite layer.
- **Session close → MemWal checkpoint:** a command (e.g. `/close`) condenses the session and
  writes a checkpoint to Walrus (**plain, no Seal**), printing the blob handle.
- **New session → recall:** a command (e.g. `/resume`) reads the checkpoint back from MemWal
  and the agent visibly continues with that context.
- **Fake job templates on Walrus:** seed a couple (crypto price-range + Polymarket) in the
  canonical shape; the agent matches, confirms, and collects parameters conversationally.
- **No oracle data, no Intake, no payment** — stops at a confirmed, parameter-complete intent.

### Demo Walrus access — LOCKED (2026-06-08): public publisher, NO local fallback
Real Walrus **writes need gas (a funded Sui wallet)**, but the demo must run from **only a Groq
key**. **Decision: use the public Walrus testnet HTTP publisher/aggregator** — real Walrus, no
wallet (the publisher sponsors the write; `PUT /v1/blobs?epochs=N`, `GET /v1/blobs/{blobId}`).
Proven usable in this project (phase 0 P0b). Job templates + checkpoints both go here.
(Bundling a funded wallet was rejected — would ship a private key to GitHub.)

**No local simulation.** MemWal must genuinely live on Walrus. If the public endpoint is
unreachable or a blob does not round-trip, the demo **fails loudly with a clear error** (so we
fix the real connectivity/endpoint problem) — it must NOT fall back to a local-file stand-in.
Use a **multi-epoch window** (phase-0 proved `epochs=1` certifies but is NOT retrievable).

Note: the demo's HTTP-publisher path is **separate** from `plugin-walrus` (which is SDK +
signer). The demo gets a thin `walrusHttp` client; the framework keeps the SDK plugin.

---

## Build order
1. **Confirm** the demo-Walrus decision above + the three cross-workstream locks (GOAL.md).
2. **A1 plugin-memwal** (plain) → **A3 agent app** (chat + checkpoint lifecycle) →
   **A4 matching/params**. These need no Seal and unblock the demo.
3. **Track B demo** in parallel once A1/A3 exist (it is the user-facing slice of A3/A4).
4. **A2 Seal integration** when the teammate's contract lands; wire it as MemWal's encrypt
   hook (prod only — the demo stays plain).

## Notes carried forward
- Build config: `@elizaos/core@1.7.2` needs `moduleResolution: Bundler` + `module: ESNext`
  (ESM); `SuiJsonRpcClient` (not GraphQL); plugin-groq's old default model is decommissioned —
  set `GROQ_LARGE_MODEL`/`GROQ_SMALL_MODEL` and pass config via `character.settings`, not
  `process.env` (memory `elizaos-standalone-gotchas`).
- Walrus: `deletable` required, `epochs >= 3` on the SDK path (memory `walrus-sdk-gotchas`).
- No git actions (no commit/push) unless the user says so.
