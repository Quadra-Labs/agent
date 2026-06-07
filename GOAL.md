# GOAL.md — Agent Framework Workstream (ElizaOS + Walrus + Seal + MemWal)

## My scope
I build the **agent framework on ElizaOS** — the "top-left of the system" in 'diagram/project_diagram.jpg': the User ↔ Agent
boundary and the agent's memory. A created agent runs on this framework and must **obey the job
template** when it submits a job response. Concretely:
- `apps/agents/` — the ElizaOS project (runtime boot, character definitions, plugin loading).
- `plugins/plugin-walrus/` — agent file system on Walrus (the "SSD").
- `plugins/plugin-seal/` — encryption for agent memory (per-use-case access policies).
- `plugins/plugin-memwal/` — durable agent memory on Walrus, encrypted via Seal.
- The agent's **memory model** (three scopes — below) and **template-conformant output**.
- The agent's **wallet-signing capability** (signs the random key in the Intake handshake).

### What I do NOT own
- **Job template creation.** Someone else defines templates and their required output shapes. My
  job is a framework where created agents *conform* to whatever template applies. I consume
  templates; I do not author them.
- The **Intake Engine** (authoritative conformance check + payment release), the **Schedule
  Engine**, the **Evaluators**, **Oracles**, the **Move economy** (token / AMM / staking /
  waterfall), the **Agent Identity DB + registration**, the indexer/api, the frontend.
- **Deferred scoring / job lifetime.** My agent produces a job response **from the job payload** —
  it does not need the user's live session to execute. What happens after submission (waiting for an
  event to resolve, then scoring) is the Schedule Engine's + Evaluator's problem. (This used to be in
  my scope — it has moved out.)

---

## The bigger picture (so my part fits the whole)
A protocol where AI agents deliver **well-defined jobs** (objective ground truth — e.g. "BTC price
range in 5m", Polymarket resolution), scored by a protocol-run evaluator (`f(x) ∈ [0,1]`), under a
single-token economy. No subjective / article-style jobs in the MVP. Agents have a "space" — files
+ memory.

A job submission looks like (provisional shape, from the team's example):
```
{ agent_id, category_id, job_id,
  agent_result:  { minPrice: 60000, maxPrice: 60100 },
  job_template:  { output: { minPrice: "number", maxPrice: "number" }, lifetime: "5m" },
  started_at_ms, delivered_at_ms }
```
My framework's job: make the agent **emit `agent_result` in exactly the shape `job_template.output`
requires**, stamped with timestamps. Free-form chat with the user is unrestricted — only the
*submitted job response* must conform.

**The seam (who does what at submission):**
- My agent produces a conformant `agent_result` (+ timestamps), **self-validates** it against the
  template (fail-fast convenience), and submits it through the **Intake handshake** (Intake sends a
  random key → agent signs with its wallet → Intake releases payment).
- The **authoritative** conformance check is the **Intake Engine's**, not mine. Scoring is the
  **Evaluator's**.
- Who writes the sealed job-result blob into the Walrus data layer (agent vs. Intake) is a boundary
  to confirm — see locks.

What I definitely write to Walrus is **agent memory** (below).

---

## The memory model (the heart of my part)
Three distinct scopes, three distinct access models. Collapsing them breaks either the feature or
the privacy guarantee.

**Scope boundary — jobs vs. chat.** This memory model governs the *chat* experience, **not job
execution.** A job is self-contained: the agent executes it from the **job payload** alone, with no
session history and no user presence required. So the job-read/execute path does NOT touch any of
the three scopes below — never wire session memory into it. The three scopes exist only for the
conversational side.

**1. Live chat — SQLite, ephemeral.** The working conversation. Free (no MemWal cost), not
encrypted, not durable. Most chatter never needs to persist.

**2. Agent definition — MemWal, agent-scoped.** The agent's middle-tier system prompt: skills
(e.g. web search), duty, behavior. **Written only by the agent's *creator*** (ownership check
against the creator's wallet). **Read as config by any session** of that agent, regardless of
end-user. Seal here is *optional* — this is configuration, not user-private data; encrypt only to
hide an agent's "secret sauce" prompt from competitors (agent-vs-world, not user-vs-user).

**3. Session checkpoint — MemWal + Seal, session-scoped, strictly private.** A condensed summary
of a session (the Claude-Code `/checkpoint`-to-a-`.md`-file analogy), written on a trigger. **Seal
access = option 3 (AND policy): decryptable only when BOTH the user wallet AND the agent wallet are
present** — i.e. only during a live (this user + this agent) session. Scoped by session ID.

### The three-tier prompt (assembled per session)
- **Top — job-template rule (immutable):** loaded from the template registry (not mine). The agent
  and users cannot alter it. This is what forces output conformance.
- **Middle — agent definition:** set by the creator (scope 2). Read-only to the end-user.
- **Bottom — live conversation:** the chat (scope 1, SQLite).

### Identity & isolation (get the wording exactly right)
- **User wallet** and **agent wallet** are *real cryptographic keys* (the agent has a wallet because
  it receives payment). **Session ID is a namespace/address, not a key.** "Three components" = two
  locks + one address, not three locks. Don't let anyone believe three concatenated identifiers
  equal three-factor security.
- **No cross-agent memory pooling.** Agent x talking to User B can never read User A's memory —
  User A's wallet isn't present, so option 3 won't decrypt. Knowledge pooling is OUT for the MVP
  (it is a data-exfiltration path).
- **Creator ≠ consumer.** The creator writes the middle tier; the consumer only talks. Enforcement
  is *structural* — the consumer session flow has no API that writes the agent-definition store.
  "Is this the creator?" is an ownership check (does your wallet match the agent's registered
  creator wallet?) at write time, not a session-mode flag. (The creator may also be a consumer when
  testing — the ownership check handles that.)
- **Why option 3 is safe here:** job execution reads the **job payload** (and at most the
  agent-scoped definition) — never a user-private session checkpoint — so the agent never needs to
  decrypt session memory when the user is absent. Checkpoints are read only during live chat, when
  both wallets are present. (The evaluator never touches private session memory either — it sees
  only the submitted result + template + ground truth.)

---

## The dependency chain that governs my build
Plugins build in a fixed order: **Walrus → Seal → MemWal.** MemWal composes the other two —
`memwalService` uses the Walrus and Seal services, never the reverse. No phase advances out of
order.

---

## Phases (each ends in something that demonstrably works)

### Phase 0 — Binding spike — DONE (proven, all tests passed)
ElizaOS binds to Walrus, Seal, and MemWal. Blob round-trip, Seal encrypt/decrypt with a Move-gated
policy, and MemWal memory round-trip all confirmed locally. The architecture is validated — no need
to re-litigate compatibility. `/spike-probe` is retired.

### Phase 1 — Walrus plugin (clean)
Turn the proven Walrus spike into real, structured code.
- [ ] Document the plugin shape: `services` (long-lived clients), `actions` (discrete ops),
      `providers` (context injection), `evaluators` (post-interaction memory writes). Record the
      method signatures a storage service must expose.
- [ ] `walrusService.ts` — long-lived Walrus client: store/read erasure-coded blobs.
- [ ] `storeBlob.ts` / `readBlob.ts` actions.
- [ ] `walrusStatus.ts` provider — surfaces stored-blob handles into agent context.
- [ ] Isolated test.

**Exit gate:** the agent stores AND retrieves blobs via the plugin transparently, with a passing
isolated test.

### Phase 2 — Seal plugin (clean) — both policy shapes
**Depends on:** Phase 1.
- [ ] `sealService.ts` — encrypt/decrypt with on-chain Move access policy.
- [ ] Support and test the **two policy shapes** the memory model needs:
  - **Agent-scoped (ownership):** write gated to the creator's wallet; read open to sessions.
  - **Session-scoped (option 3 / AND):** decryptable only when *both* user wallet and agent wallet
    are present.
- [ ] Encrypt/decrypt actions.

**Exit gate:** a payload round-trips, AND the option-3 policy is proven — *neither* the user wallet
*nor* the agent wallet alone can decrypt, but the two together can. (If you can't demonstrate each
party alone failing, the policy isn't real.)

### Phase 3 — The memory model (the heart) — composes Walrus + Seal
**Depends on:** Phases 1 & 2.
- [ ] **Live chat store:** SQLite, ephemeral session history.
- [ ] **Agent-definition store:** MemWal, agent-ID scoped; creator-only write (ownership check);
      read-as-config by any session.
- [ ] **Session-checkpoint store:** MemWal + Seal option-3; written on a trigger.
- [ ] `memoryProvider.ts` — recall and inject prior checkpoints into prompt context (only when both
      wallets present). Must handle **multiple checkpoints per (user, agent) pair** — a single
      session can checkpoint more than once (on-limit), so recall is across N, not the one.
- [ ] `memoryWriter.ts` — condense the session + write the checkpoint **on the session-boundary
      trigger**, not after every message (per-message writes would burn MemWal cost). If ElizaOS
      evaluators only fire per-interaction, drive this from a session-lifecycle hook instead.
- [ ] **Checkpoint trigger:** automatic, **no user command** — fires on session-leave AND on hitting
      a session-length limit (so a session may produce multiple checkpoints). Writing *encrypts to*
      the (user, agent) policy; confirm the writer still has what it needs to encrypt at the
      session-end boundary (encryption targets an identity, doesn't require it live).
- [ ] **Consumer write-path lockout:** the end-user session structurally cannot write the
      agent-definition (middle) tier.

**Exit gate:** (a) memory survives across sessions — written encrypted on Walrus, the *right*
checkpoint recalled later; (b) a checkpoint for (User A, agent x) **cannot** be decrypted in a
(User B, agent x) session — isolation demonstrated, not assumed; (c) an end-user (non-creator)
cannot modify the agent definition.

### Phase 4 — Agent framework: conformance + signing
**Depends on:** Phase 3.
- [ ] **Three-tier prompt assembly:** immutable job-template rule (top, from registry — provisional
      shape) + creator-set agent definition (middle) + live chat (bottom).
- [ ] **Job read/execute:** the agent reads and executes an assigned job from the **job payload**
      (read-only; self-contained — does NOT touch the session memory model).
- [ ] **Conformant output:** emit `agent_result` matching `job_template.output`, with
      `started_at_ms` / `delivered_at_ms`.
- [ ] **Client-side self-validation:** reject malformed output before submission (fail-fast; the
      authoritative gate is still Intake).
- [ ] **Wallet signing:** the agent signs the Intake handshake's random key with its wallet.
- [ ] One reference agent (`predictor` / `btc-price-guess`) running this end to end.

**Exit gate:** a job goes in → reference agent runs with full memory → emits a template-conformant,
timestamped `agent_result` → self-validates → signs the handshake. The full happy path of my
workstream.

### Phase 5 — Reusability + demo-hardening
**Depends on:** Phase 4.
- [ ] A **second agent of a different category** (the plan's `analyst`-style), proving the framework
      generalizes — not hardcoded to one job type.
- [ ] **Author README (<1 page):** how to build a conformant agent on this framework. The
      "integration/tooling" deliverable the hackathon explicitly asks for — a judged artifact, not
      an afterthought.
- [ ] **Cross-workstream dry-run** with the Intake + Evaluator owners: agent submits → Intake
      checks conformance + releases → Evaluator scores.

**Exit gate:** two different-category agents run on the framework with full memory/isolation, both
emit conformant signed submissions, and the integrated handoff works in a dry run.

---

## Explicitly OUT of scope (guard against scope creep)
- Job template creation/registry — template workstream. I consume, not author.
- Move economy, token, AMM, staking, fee waterfall — economy workstream.
- Intake Engine, Schedule Engine, Evaluators, Oracles — their own workstreams.
- Deferred scoring / job lifetime resolution — Schedule Engine + Evaluator.
- Agent Identity DB + registration — identity workstream. (My agent must be *able* to sign; the
  registry that links agent ID ↔ wallet is not mine.)
- Indexer, read API, web frontend.
- Cross-agent knowledge pooling — cut for MVP (exfiltration risk).
- Multi-agent coordination — deferred; single-agent first. Revisit only if Phases 1–4 finish early.

## Cross-workstream dependencies I must lock (don't build to a guess)
1. **Job template schema** *(consumed — owned by the template workstream)*. Provisional shape = the
   team's example (`{ output: {...}, lifetime }`). My agents conform to whatever this locks to.
2. **Job submission/response payload schema** — what my agent emits; Intake checks it and the
   Evaluator reads it (`agent_id`, `category_id`, `job_id`, `agent_result`, `started_at_ms`,
   `delivered_at_ms`).
3. **Job request schema** — what the agent reads as an incoming job.
4. **Intake signature-handshake format** — what Intake sends (the random key) and the exact shape
   it expects back (what is signed, how the signature is returned).
- *(Conditional)* **Who writes the sealed job-result blob to the Walrus data layer** — my agent or
  Intake. Confirm before assuming.

Use `/lock-dependency` the moment each is agreed. I am **not** the unilateral owner of #1–#4 —
they are shared contracts; get the owning side to sign off.

## Definition of done (my part)
A stranger can write an ElizaOS agent on this framework, give it a creator-set definition, and have
it: run with SQLite live chat + Seal-encrypted MemWal memory that is **strictly isolated per (user,
agent) pair**; load an immutable job-template rule it cannot bypass; produce a **template-conformant,
timestamped job response**; self-validate it; and sign the Intake handshake — all while the end-user
can talk freely but can neither read another user's memory nor alter the agent's definition.