// jobLifecycle.ts — the automatic coordinator that drives a job through the intake
// engine from a freeform chat. After each turn the CLI calls advanceJobLifecycle, which
// reads the transcript, decides the next step deterministically, makes the one network
// call that step needs, and returns the next state + user-facing notes. NEVER throws
// (model calls are guarded; the service clients never throw). It is INERT unless the
// character offers templates, a signer is present, and an intake URL is set — so a plain
// chat session is byte-identical to before.
//
// Lifecycle (PAYMENT-FIRST): idle --(agent accepts a job + quotes a cost)--> submitted (job_id
// minted; user told what to pay; agent keeps gathering params) --(payment confirmed AND all
// params collected)--> delivering (result produced + sealed + handed to the gateway; the CLI
// hands delivery to the background deliveryPoll) --> done. The agent does NO work until the
// user has paid: the `paid` flag is set by a `job_paid` socket push (see intakeSocket.ts) or a
// status-probe reconcile, and only `paid && all-params` triggers produce+seal. The
// conversational phases (idle, submitted) are turn-driven because the user is actively chatting
// to commit and provide params; delivery is NOT turn-driven (see deliveryPoll.ts) so a job
// still delivers if the user goes silent after paying. The collected params + readiness are
// persisted to a MemWal job-draft (jobDraft.ts) each turn, so readiness survives turns/restarts
// rather than being re-derived from the transcript alone.

import { ModelType } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import type { Signer } from "@mysten/sui/cryptography";

import type { AgentConfig } from "../runtime/config.js";
import type { ChatTurn } from "../chat/chatMemory.js";
import { validateParamValue, parseDurationMs, type IntakeTemplate } from "../templates/intakeTemplate.js";
import { flattenTranscript } from "../session/closeSession.js";
import { extractCollectedParams } from "./paramExtraction.js";
import { produceAndSealResult, type ProduceHook } from "./jobResult.js";
import { submitJob, type IntakeSession } from "../quadra/intakeClient.js";
import { registerSealedResult } from "../quadra/dataGatewayClient.js";
import { saveJobDraft, loadJobDraft } from "./jobDraft.js";

// plugin-groq returns this sentinel instead of throwing; treat it as a non-commitment.
const GROQ_ERROR_SENTINEL = "Error generating text. Please try again later.";

// idle -> submitted -> delivering -> done. The turn-driven coordinator owns idle +
// submitted; once the result is registered (delivering), the background deliveryPoll
// owns the job and the coordinator no-ops until it is done.
export type JobPhase = "idle" | "submitted" | "delivering" | "done";

export interface JobState {
  readonly phase: JobPhase;
  /** The accepted template (set from `submitted` onward). */
  readonly template?: IntakeTemplate;
  /** The intake session minted at submit (set from `submitted` onward). */
  readonly session?: IntakeSession;
  /** When the job was submitted; the delivery poller's deadline bounds run from here. */
  readonly submittedAtMs?: number;
  /** The user-chosen lifetime (e.g. "5m") submitted for this job; sealed into the result. */
  readonly lifetime?: string;
  /** Set once a `job_paid` push (or status probe) confirms the user's on-chain payment for
   * `session.job_id`. The agent produces NOTHING until this is true (payment-first). */
  readonly paid?: boolean;
  /** The on-chain paid_at_ms from the `job_paid` event = the job clock start (sealed as
   * `started_at`). */
  readonly paidAtMs?: number;
}

export interface AdvanceJobLifecycleInput {
  readonly runtime: IAgentRuntime;
  readonly turns: readonly ChatTurn[];
  readonly config: AgentConfig;
  readonly signer: Signer;
  /** The templates the character offers, to resolve a committed category_id. */
  readonly templates: readonly IntakeTemplate[];
  readonly state: JobState;
  /** The character name — the MemWal job-draft index key (part 1). */
  readonly agent: string;
  /** The live conversation room id — the MemWal job-draft index key (part 2). */
  readonly room: string;
  /** Optional result producer (e.g. the Pyth price-range skill). When set it replaces the
   * default LLM producer for this job's result. */
  readonly produce?: ProduceHook;
  /** Injectable clock (tests). Defaults to Date.now. */
  readonly now?: () => number;
}

export interface AdvanceResult {
  readonly state: JobState;
  /** Lines the CLI prints to the user (payment instructions, delivery status, errors). */
  readonly notes: readonly string[];
}

// Narrow the free-form config.walrusNetwork to the Seal client's network union.
function narrowNetwork(n: string): "testnet" | "mainnet" | "devnet" | "localnet" {
  return n === "mainnet" || n === "devnet" || n === "localnet" ? n : "testnet";
}

// --- acceptance classifier (idle -> submitted trigger) -----------------------
//
// The AGENT decides whether to take a job and what to charge — the user does not set the
// price, and the agent may decline (developer rules live in the character's system
// prompt; the agent has the final word). So the trigger is: the agent has accepted ONE
// specific job AND quoted a numeric cost. A decline never surfaces a non-null id.

export interface AcceptanceDecision {
  /** The accepted template's category_id, or null if the agent has not accepted one. */
  readonly templateId: string | null;
  /** The cost (base units) the agent quoted, or null if none stated yet. */
  readonly cost: number | null;
  /** The asset/market the job targets (e.g. "BTC"), or null if none stated. The intake
   * engine requires it and validates it against the template's allowed assets. */
  readonly asset: string | null;
  /** The lifetime/window the USER asked for (a duration like "5m"), or null if none stated or
   * it is below the template's minimum. The intake engine requires it (>= minimum_lifetime). */
  readonly lifetime: string | null;
}

function buildAcceptancePrompt(templates: readonly IntakeTemplate[], transcript: string): string {
  const jobLines = templates
    .map((t) => {
      const assets =
        t.allowedAssets && t.allowedAssets.length > 0
          ? ` (allowed assets: ${t.allowedAssets.join(", ")})`
          : "";
      const minLt =
        t.minimumLifetimeMs !== undefined
          ? `, minimum lifetime ${Math.round(t.minimumLifetimeMs / 1000)}s`
          : "";
      return `  - ${t.id}: ${t.description}${assets}${minLt}`;
    })
    .join("\n");
  return [
    "Decide whether the AGENT (not the user) has agreed to take on ONE specific job from the",
    "list below: it must have told the user a price, which asset it targets, AND the lifetime",
    "(time window) the user asked for. The agent has the final say and may decline. Output ONLY",
    "a single JSON object:",
    '  { "accepted_template_id": "<id>", "cost": <number>, "asset": "<SYMBOL>", "lifetime": "<dur>" }',
    "      using one of the exact ids, the numeric price the agent quoted, the asset symbol",
    '      (uppercase, e.g. BTC), and the lifetime as a duration string ("30s"/"5m"/"2h"/"1d"), OR',
    '  { "accepted_template_id": null, "cost": null, "asset": null, "lifetime": null }  if the',
    "      agent has not yet clearly accepted a specific job at a price for a specific asset and",
    "      lifetime. Be conservative: null unless ALL of id, cost, asset, and lifetime are clear.",
    "No prose, no markdown, no code fences -- just the raw JSON object.",
    "",
    "Jobs:",
    jobLines,
    "",
    "Conversation:",
    transcript,
    "",
    "JSON object:",
  ].join("\n");
}

// Return the agent's acceptance decision: the accepted category_id (validated against the
// offered templates) and the quoted cost, each null when absent. A leak-guarded
// structured call; tolerates fenced/prose-wrapped JSON. May throw if the model call
// itself throws — the caller guards it.
async function classifyAcceptance(
  runtime: IAgentRuntime,
  templates: readonly IntakeTemplate[],
  turns: readonly ChatTurn[],
): Promise<AcceptanceDecision> {
  const none: AcceptanceDecision = { templateId: null, cost: null, asset: null, lifetime: null };
  const raw = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: buildAcceptancePrompt(templates, flattenTranscript(turns)),
  });
  const text = (typeof raw === "string" ? raw : String(raw ?? "")).trim();
  if (text.length === 0 || text === GROQ_ERROR_SENTINEL) return none;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return none;
  }
  if (parsed === null || typeof parsed !== "object") return none;
  const id = (parsed as { accepted_template_id?: unknown }).accepted_template_id;
  const cost = (parsed as { cost?: unknown }).cost;
  const asset = (parsed as { asset?: unknown }).asset;
  const lifetime = (parsed as { lifetime?: unknown }).lifetime;
  const templateId = typeof id === "string" && templates.some((t) => t.id === id) ? id : null;
  // Base-unit costs are integers (the on-chain pay_for_job takes a u64); round a quoted
  // value and require it positive.
  const validCost = typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? Math.round(cost) : null;
  // Constrain the asset to the chosen template's allowed list (the intake engine requires it):
  // a value outside the list yields null, so the agent keeps clarifying instead of submitting a
  // doomed request. With no declared list, the symbol passes through uppercased.
  const validAsset = normalizeAsset(asset, templateId, templates);
  // Validate the user-requested lifetime parses AND meets the template's minimum; otherwise null
  // so the agent keeps clarifying rather than submitting a window the engine will reject.
  const validLifetime = normalizeLifetime(lifetime, templateId, templates);
  return { templateId, cost: validCost, asset: validAsset, lifetime: validLifetime };
}

// Validate the model's lifetime against the chosen template's minimum. Returns the trimmed
// duration string when it parses AND (if the template declares minimumLifetimeMs) is at least
// that long; otherwise null. The intake engine re-validates server-side.
function normalizeLifetime(
  lifetime: unknown,
  templateId: string | null,
  templates: readonly IntakeTemplate[],
): string | null {
  if (typeof lifetime !== "string" || lifetime.trim().length === 0) return null;
  const raw = lifetime.trim();
  const ms = parseDurationMs(raw);
  if (ms === undefined) return null;
  const template = templateId !== null ? templates.find((t) => t.id === templateId) : undefined;
  const min = template?.minimumLifetimeMs;
  if (min !== undefined && ms < min) return null;
  return raw;
}

// Normalize the model's asset to a value the intake engine will accept. When the chosen
// template declares allowed assets, return the canonical casing of the matching one (or null if
// none matches); otherwise pass the symbol through uppercased.
function normalizeAsset(
  asset: unknown,
  templateId: string | null,
  templates: readonly IntakeTemplate[],
): string | null {
  if (typeof asset !== "string" || asset.trim().length === 0) return null;
  const raw = asset.trim();
  const template = templateId !== null ? templates.find((t) => t.id === templateId) : undefined;
  const allowed = template?.allowedAssets;
  if (allowed && allowed.length > 0) {
    return allowed.find((a) => a.toLowerCase() === raw.toLowerCase()) ?? null;
  }
  return raw.toUpperCase();
}

// The REQUIRED param names for a template (validation.required !== false). Snapshotted into
// the draft so readiness can be judged without the template at read time.
function requiredParamNames(template: IntakeTemplate): string[] {
  return Object.entries(template.params)
    .filter(([, p]) => p.validation?.required !== false)
    .map(([name]) => name);
}

/**
 * Fold a payment confirmation into the job state (pure). Ignores a payment for a different /
 * absent job (stale or foreign push) and is idempotent once `paid`. The CLI calls this when a
 * `job_paid` socket push arrives or a status probe reports paid; the next lifecycle step then
 * gates produce+seal on `paid && all-params`.
 */
export function applyJobPaid(
  state: JobState,
  event: { readonly job_id: string; readonly paid_at_ms?: number },
): JobState {
  if (state.session === undefined) return state;
  if (event.job_id !== state.session.job_id) return state;
  if (state.paid === true) return state;
  return {
    ...state,
    paid: true,
    ...(event.paid_at_ms !== undefined ? { paidAtMs: event.paid_at_ms } : {}),
  };
}

// --- phase handlers ----------------------------------------------------------

async function handleIdle(input: AdvanceJobLifecycleInput): Promise<AdvanceResult> {
  const { runtime, turns, config, signer, templates, state } = input;
  const notes: string[] = [];

  let decision: AcceptanceDecision;
  try {
    decision = await classifyAcceptance(runtime, templates, turns);
  } catch {
    return { state, notes }; // model hiccup — try again next turn, no user noise
  }
  // The agent must have accepted a specific job AND quoted a cost AND named an asset AND a
  // valid lifetime (>= the template minimum). A decline, or any missing field, simply waits
  // (no submit, no noise). The user-chosen lifetime is what gets submitted.
  if (
    decision.templateId === null ||
    decision.cost === null ||
    decision.asset === null ||
    decision.lifetime === null
  ) {
    return { state, notes };
  }

  const template = templates.find((t) => t.id === decision.templateId);
  if (!template) return { state, notes };

  const submitted = await submitJob({
    baseUrl: config.intakeUrl,
    signer,
    templateId: decision.templateId,
    lifetime: decision.lifetime,
    cost: decision.cost,
    asset: decision.asset,
  });
  if (!submitted.ok) {
    notes.push(`Could not open the job (${submitted.kind}): ${submitted.message}.`);
    return { state, notes };
  }

  const s = submitted.session;
  const required = requiredParamNames(template);

  // Persist the opening draft (template + session) so readiness can build on it across turns.
  await saveJobDraft({
    runtime: input.runtime,
    agent: input.agent,
    room: input.room,
    draft: {
      templateId: template.id,
      session: s,
      collected: {},
      requiredParams: required,
      ready: false,
      phase: "submitted",
      paid: false,
    },
    ...(input.now ? { now: input.now } : {}),
  });

  // Relay the session for the user's wallet/dApp to pay FIRST (payment-first: no work until
  // the payment confirms). The dApp bakes in the AgentRegistry / JobAccessRegistry constants
  // and the Clock (0x6); everything else comes from this session.
  notes.push(
    "Job opened. PAY FIRST to start it. Relay this session to your wallet/dApp:",
    `  session_id=${s.session_id} job_id=${s.job_id} agent_wallet=${s.agent_wallet} cost=${s.cost}`,
    "  The dApp builds: quadra::intake::pay_for_job(AGENT_REGISTRY, JOB_ACCESS_REGISTRY,",
    "    session_id, job_id, agent_wallet, payment: Coin<QUADRA>(cost), 0x6)",
    "(The session is held ~15 min. I'll keep gathering details and finish the moment your payment confirms.)",
  );
  return {
    state: {
      phase: "submitted",
      template,
      session: s,
      submittedAtMs: (input.now ?? Date.now)(),
      lifetime: decision.lifetime,
      paid: false,
    },
    notes,
  };
}

// PAYMENT-FIRST: keep collecting params and persist the draft each turn, but produce + seal +
// register the result ONLY once the user has paid (state.paid) AND every required param is in.
// The agent therefore never does (paid-compute) work before being paid.
async function handleSubmitted(input: AdvanceJobLifecycleInput): Promise<AdvanceResult> {
  const { runtime, turns, config, signer, state, agent, room } = input;
  const notes: string[] = [];
  const template = state.template;
  const session = state.session;
  if (!template || !session) return { state, notes };

  let extracted;
  try {
    extracted = await extractCollectedParams(runtime, template, turns);
  } catch {
    return { state, notes };
  }
  if (!extracted.ok) return { state, notes };

  // Merge the freshly extracted values over the persisted draft so readiness builds up across
  // turns from MemWal (not just this turn's transcript pass). The draft is the source of the
  // collected set we judge and ultimately produce from.
  const priorDraft = await loadJobDraft({ runtime, agent, room });
  const merged: Record<string, string> = { ...(priorDraft?.collected ?? {}), ...extracted.collected };

  // Need only the REQUIRED params (validation.required !== false), and each present value must
  // pass the template's declared validation. An optional/invalid value keeps collecting.
  const required = requiredParamNames(template);
  const allCollected = required.every((n) => {
    const v = merged[n];
    return typeof v === "string" && v.length > 0 && validateParamValue(template.params[n], v).ok;
  });

  // Persist the updated draft (collected + readiness + paid) every turn — best-effort.
  await saveJobDraft({
    runtime,
    agent,
    room,
    draft: {
      templateId: template.id,
      session,
      collected: merged,
      requiredParams: required,
      ready: allCollected,
      phase: "submitted",
      paid: state.paid === true,
    },
    ...(input.now ? { now: input.now } : {}),
  });

  // Gate on payment: the agent does NOTHING until the user has paid. Surface a one-time nudge
  // when the agent is otherwise ready and only the payment is outstanding.
  if (state.paid !== true) {
    if (allCollected) {
      notes.push("I have everything I need; I'll start the moment your on-chain payment confirms.");
    }
    return { state, notes };
  }

  if (!allCollected) return { state, notes }; // paid early — keep collecting; no noise

  const agentAddress = signer.toSuiAddress();
  const sealed = await produceAndSealResult(runtime, {
    jobId: session.job_id,
    template,
    collected: merged,
    packageId: config.sealPackageId,
    keyServerIds: config.sealKeyServerIds,
    threshold: config.sealThreshold,
    network: narrowNetwork(config.walrusNetwork),
    ...(input.produce !== undefined ? { produce: input.produce } : {}),
    // Envelope metadata: in the single-wallet demo the payer == the agent.
    agentAddress,
    userAddress: agentAddress,
    lifetime: state.lifetime ?? template.lifetime ?? "5m",
    startedAtMs: state.paidAtMs ?? state.submittedAtMs ?? (input.now ?? Date.now)(),
    ...(input.now ? { now: input.now } : {}),
  });
  if (!sealed.ok) {
    notes.push(`Could not prepare the result (${sealed.kind}): ${sealed.message}.`);
    return { state, notes };
  }

  const registered = await registerSealedResult({
    baseUrl: config.dataGatewayUrl,
    signer,
    jobId: session.job_id,
    ciphertext: sealed.ciphertext,
  });
  if (!registered.ok) {
    notes.push(
      `Could not register the result with the data gateway (${registered.kind}): ${registered.message}.`,
    );
    return { state, notes };
  }

  // Record the delivering phase in the draft, then hand the job to the background delivery
  // poller (the CLI starts it on this transition) so delivery proceeds even if the user goes
  // silent. Delivery is intentionally NOT done here.
  await saveJobDraft({
    runtime,
    agent,
    room,
    draft: {
      templateId: template.id,
      session,
      collected: merged,
      requiredParams: required,
      ready: true,
      phase: "delivering",
      paid: true,
    },
    ...(input.now ? { now: input.now } : {}),
  });

  notes.push(`Result prepared and registered (blob ${registered.blobId}).`);
  return {
    state: { phase: "delivering", template, session, submittedAtMs: state.submittedAtMs, paid: true },
    notes,
  };
}

/**
 * Advance the job lifecycle by one turn. Inert (returns state unchanged, no notes) when
 * there are no templates. Dispatches on the current phase; `delivering` (owned by the
 * background poller) and `done` are no-ops. NEVER throws.
 */
export async function advanceJobLifecycle(
  input: AdvanceJobLifecycleInput,
): Promise<AdvanceResult> {
  const { state, templates } = input;
  if (templates.length === 0) return { state, notes: [] };

  switch (state.phase) {
    case "idle":
      return handleIdle(input);
    case "submitted":
      return handleSubmitted(input);
    case "delivering":
    case "done":
    default:
      return { state, notes: [] };
  }
}
