# GOAL.md — Agent Framework (ElizaOS + Walrus + MemWal; consumes Seal)

> Rewritten 2026-06-08 to correct scope. Supersedes the earlier draft. The earlier
> phase plans are folded into `PLAN.md` (the single authoritative plan); `PHASE1_PLAN.md`
> (Walrus, DONE) and `PHASE2_PLAN.md` (Seal — now *consumed*, not authored) are kept as
> evidence/reference only.

## My scope — the agent framework on ElizaOS
I build the **User ↔ Agent boundary and the agent's memory** — the top-left of
`diagram/project_diagram.jpg`. A created agent runs on this framework, chats with a user,
and — when the user is describing a job — matches that conversation to a **job template**
and collects the template's parameters. Concretely I own:

- **The ElizaOS agent runtime** — boot, character/definition, plugin loading. (`apps/agent/`)
- **Two memory stores:**
  1. **SQLite (local DB) — live chat history**, session by session. Free, not encrypted,
     not paid. Most chatter lives only here.
  2. **MemWal — session checkpoints** (condensed session summaries) on Walrus. Paid (gas),
     so written **only on a session boundary**, never per message. In production a
     checkpoint is **Seal-encrypted with per-(user, agent) isolation** — using a Seal
     contract **written by another teammate** (I consume it; I do not author it).
- **`plugins/plugin-walrus/`** — agent storage on Walrus (the "SSD"). **DONE.**
- **`plugins/plugin-memwal/`** — durable checkpoint memory on Walrus (composes Walrus;
  optionally Seal). To build.
- **`plugins/plugin-seal/`** — the **client-side** Seal integration (encrypt/decrypt via
  `SealClient`, build the `seal_approve` PTB) that **points at the teammate's deployed
  contract**. To build. The Move policy itself is theirs.
- **Job-template matching + parameter collection** — read templates (a Walrus object) for
  the agent's category, match the user's conversation, confirm ("is this the job you mean?"),
  then collect each template parameter **conversationally** (never dump the template into
  chat).
- **Outbound Intake notification** — when the user confirms, the agent tells the Intake
  Engine a job is pending: `{ user_wallet, job_template, job_id, agent_id }`. The agent has
  a wallet. The **cryptographic auth/signing of that channel is the Intake side's, not mine.**

### What I do NOT own
- **The Seal Move contract / access policy.** A teammate authors and deploys it; I integrate
  against its `packageId` + policy object. (My option-3 spike becomes the **spec I hand them.**)
- **Job-template authoring.** Templates are defined elsewhere; I consume them.
- **Intake Engine, Schedule Engine, Evaluation Engine (Nautilus), Oracles.**
- **The Agent ↔ Intake authentication/signing protocol** (the random-key handshake).
- **Smart contracts, Move economy, token, AMM, staking, payment/escrow.**
- **Agent Identity DB + registration**, indexer, read API, frontend.
- **Job execution from live data.** In the full system the agent pulls from oracles; that
  data path and the deferred scoring are the Schedule/Evaluation engines' problem.

---

## The bigger picture (so my part fits the whole)
A protocol where AI agents deliver **well-defined jobs** (objective ground truth — e.g.
"BTC price range in 5m", Polymarket resolution), scored by a protocol-run evaluator, under a
single-token economy. Developer-tier users build agents on this framework; regular users
either just chat with an agent (powering it locally) or **ask it for a job** (priced, taken
by the Intake Engine). The agent never decides job acceptance — it only matches the closest
template and notifies Intake. No subjective jobs in the MVP.

**Canonical job shape (team contract — from the `process_data` example):**
```json
{
  "agent_id": "0x…",
  "category_id": "btc-price-guess",
  "job_id": "job-2",
  "agent_result":     { "minPrice": 60000, "maxPrice": 60100 },
  "finalized_result": { "price": 59950 },
  "job_template":     { "output": { "minPrice": "number", "maxPrice": "number" }, "lifetime": "5m" },
  "started_at_ms":    1700000000000,
  "delivered_at_ms":  1700000060000
}
```
`finalized_result` (oracle ground truth) and the scoring belong to the Evaluation Engine.
My framework's contract is the **`job_template`** (`output` shape + `lifetime`) and producing
an `agent_result` that matches `output`. `category_id` selects which template applies.

For matching + parameter collection a template also carries agent-facing fields (a `title`
and a `params` map with the questions to ask). Whether those live in the canonical template
or only in the matching layer is a lock with the template owner (see PLAN.md).

---

## The memory model (lean — two stores)
**Scope boundary — jobs vs. chat.** This memory model governs the *chat* experience, **not job
execution.** A job is self-contained: the agent executes it from the job payload alone, with
no session history. The job path never reads session memory.

1. **Live chat — SQLite, ephemeral.** The working conversation. Free, not encrypted.
2. **Session checkpoint — MemWal, written on a session boundary.** A condensed summary of a
   session, written on **session-leave AND on a session-length limit** (so one session may
   produce multiple checkpoints). Recalled at the **start of a new (user, agent) session** so
   the agent continues with context. **Production: Seal-encrypted, per-(user, agent)
   isolation** (a checkpoint for User A + agent X cannot be read in a User B + agent X
   session) — via the teammate's Seal contract. **Demo: no Seal** (plain blobs), so anyone can
   run it without a Seal deployment.

The agent's creator-set **definition / system prompt** (skills, duty, behavior) is the agent's
identity; it is configuration, read by any session, written only by the creator. Kept simple —
not a separate encrypted tier in this scope.

### Identity & isolation
- **User wallet** and **agent wallet** are real cryptographic keys (the agent has one because
  it receives payment). **Session ID is a namespace/address, not a key.**
- **No cross-agent / cross-user memory pooling** — the per-(user, agent) Seal policy is what
  enforces it in production. Knowledge pooling is OUT for the MVP.

---

## The demo (separate folder — a first-class deliverable)
`demo/` is a **standalone terminal app** that demonstrates *my part* end to end. A teammate
clones it, **puts one API key in `.env`**, runs it. The user will publish it to GitHub;
**I do not push.** It must show:
1. **Chat** with the agent in the terminal.
2. **Inspect SQLite** — a command/output that shows what the chat wrote to the local DB.
3. **Close a session** → a **checkpoint is written to MemWal** (plain, no Seal in the demo).
4. **New session** → the user can **recall the checkpoint from MemWal** and watch the agent
   continue with that context.
5. **Fake job templates on Walrus** (e.g. a crypto price-range job and a Polymarket job, in
   the canonical shape) — when the user starts describing a job, the agent **matches** one and
   asks *"is this the job you're describing?"*, then **collects each parameter
   conversationally** ("which cryptocurrency?", "what should I predict?", "over what window?").
6. **No oracle data, no Intake call, no payment** — in the full system the agent would pull
   from oracles; the demo stops at a confirmed, parameter-complete job intent.

---

## Dependency chain
**Walrus (DONE) → MemWal (build) → Seal integration (consume external contract) → agent
framework → demo.** MemWal composes Walrus; the Seal layer is optional/pluggable so MemWal
runs plain (demo) or encrypted (prod).

---

## Cross-workstream locks (don't build to a guess)
1. **Job template schema** *(consumed)* — `job_template: { output, lifetime }` confirmed from
   the team example; the `title`/`params` matching fields need sign-off from the template owner.
2. **Intake notification shape** — what the agent sends Intake on a pending job
   (`{ user_wallet, job_template, job_id, agent_id }`) — confirm with the Intake owner.
3. **Seal contract interface** *(consumed)* — `packageId`, policy object id, and the
   `seal_approve` signature my client must call for the per-(user, agent) policy — from the
   teammate. My spike (`phase0/spike/task1_bysender/`) is the **spec handed to them.**

## Definition of done (my part)
A stranger writes an ElizaOS agent on this framework and has it: chat with SQLite live history;
write/recall **MemWal session checkpoints** across sessions (Seal-encrypted + per-(user, agent)
isolated in production, plain in the demo); read **job templates from Walrus**, match a user's
conversation to one, confirm it, and collect every template parameter conversationally; and
notify Intake of a pending job — all packaged so the `demo/` app runs from a single API key.
