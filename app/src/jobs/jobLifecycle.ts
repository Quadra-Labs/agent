// jobLifecycle.ts — the automatic coordinator that drives a job through the intake
// engine from a freeform chat. After each turn the CLI calls advanceJobLifecycle, which
// reads the transcript, decides the next step deterministically, makes the one network
// call that step needs, and returns the next state + user-facing notes. NEVER throws
// (model calls are guarded; the service clients never throw). It is INERT unless the
// character offers templates, a signer is present, and an intake URL is set — so a plain
// chat session is byte-identical to before.
//
// Lifecycle: idle --(agent accepts a job + quotes a cost)--> submitted (job_id minted;
// user told what to pay) --(all params collected)--> delivering (result sealed + handed to
// the gateway; the CLI hands delivery to the background deliveryPoll) --> done. The
// conversational phases (idle, submitted) are turn-driven because the user is actively
// chatting to commit and provide params; delivery is NOT turn-driven (see deliveryPoll.ts)
// so a job still delivers if the user goes silent after paying.

import { ModelType } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import type { Signer } from "@mysten/sui/cryptography";

import type { AgentConfig } from "../runtime/config.js";
import type { ChatTurn } from "../chat/chatMemory.js";
import { validateParamValue, type IntakeTemplate } from "../templates/intakeTemplate.js";
import { flattenTranscript } from "../session/closeSession.js";
import { extractCollectedParams } from "./paramExtraction.js";
import { produceAndSealResult } from "./jobResult.js";
import { submitJob, type IntakeSession } from "../quadra/intakeClient.js";
import { registerSealedResult } from "../quadra/dataGatewayClient.js";

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
}

export interface AdvanceJobLifecycleInput {
  readonly runtime: IAgentRuntime;
  readonly turns: readonly ChatTurn[];
  readonly config: AgentConfig;
  readonly signer: Signer;
  /** The templates the character offers, to resolve a committed category_id. */
  readonly templates: readonly IntakeTemplate[];
  readonly state: JobState;
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
}

function buildAcceptancePrompt(templates: readonly IntakeTemplate[], transcript: string): string {
  const jobLines = templates.map((t) => `  - ${t.id}: ${t.description}`).join("\n");
  return [
    "Decide whether the AGENT (not the user) has agreed to take on ONE specific job from",
    "the list below AND has told the user a price for it. The agent has the final say and",
    "may decline. Output ONLY a single JSON object:",
    '  { "accepted_template_id": "<id>", "cost": <number> }  using one of the exact ids and',
    "                                                        the numeric price the agent quoted, OR",
    '  { "accepted_template_id": null, "cost": null }         if the agent has not yet clearly',
    "                                                        accepted a specific job at a price.",
    "Be conservative: null unless the agent clearly accepted a specific job AND stated a",
    "numeric cost. No prose, no markdown, no code fences -- just the raw JSON object.",
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
  const none: AcceptanceDecision = { templateId: null, cost: null };
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
  const templateId = typeof id === "string" && templates.some((t) => t.id === id) ? id : null;
  // Base-unit costs are integers (the on-chain pay_for_job takes a u64); round a quoted
  // value and require it positive.
  const validCost = typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? Math.round(cost) : null;
  return { templateId, cost: validCost };
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
  // The agent must have accepted a specific job AND quoted a cost. A decline, or an
  // acceptance without a stated price, simply waits (no submit, no noise).
  if (decision.templateId === null || decision.cost === null) return { state, notes };

  const template = templates.find((t) => t.id === decision.templateId);
  if (!template) return { state, notes };

  const submitted = await submitJob({
    baseUrl: config.intakeUrl,
    signer,
    templateId: decision.templateId,
    lifetime: template.lifetime,
    cost: decision.cost,
  });
  if (!submitted.ok) {
    notes.push(`Could not open the job (${submitted.kind}): ${submitted.message}.`);
    return { state, notes };
  }

  const s = submitted.session;
  notes.push(
    "Job opened with the intake engine. To proceed, sign this on-chain payment:",
    `  pay_for_job(session_id="${s.session_id}", job_id="${s.job_id}", ` +
      `agent_wallet="${s.agent_wallet}", cost=${s.cost})`,
    "(The session is held ~15 min; I'll deliver automatically once the payment confirms.)",
  );
  return {
    state: { phase: "submitted", template, session: s, submittedAtMs: (input.now ?? Date.now)() },
    notes,
  };
}

// Produce + seal the result and register it with the data gateway, then move to
// `registered` and attempt delivery. Runs once all params are collected.
async function handleSubmitted(input: AdvanceJobLifecycleInput): Promise<AdvanceResult> {
  const { runtime, turns, config, signer, state } = input;
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

  // Need only the REQUIRED params (validation.required !== false), and each present value
  // must pass the template's declared validation. An optional/invalid value keeps collecting.
  const requiredNames = Object.entries(template.params)
    .filter(([, p]) => p.validation?.required !== false)
    .map(([name]) => name);
  const allCollected = requiredNames.every((n) => {
    const v = extracted.collected[n];
    return typeof v === "string" && v.length > 0 && validateParamValue(template.params[n], v).ok;
  });
  if (!allCollected) return { state, notes }; // keep collecting; no noise

  const sealed = await produceAndSealResult(runtime, {
    jobId: session.job_id,
    template,
    collected: extracted.collected,
    packageId: config.sealPackageId,
    keyServerIds: config.sealKeyServerIds,
    threshold: config.sealThreshold,
    network: narrowNetwork(config.walrusNetwork),
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

  notes.push(`Result prepared and registered (blob ${registered.blobId}).`);
  // Hand the job to the background delivery poller (the CLI starts it on this transition).
  // Delivery is intentionally NOT done here so it proceeds even if the user stops chatting.
  return {
    state: { phase: "delivering", template, session, submittedAtMs: state.submittedAtMs },
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
