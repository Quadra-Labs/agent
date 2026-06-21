// templateSelector.ts — the agent's SELF-SELECTION: per pre-filtered candidate, one
// leak-guarded structured model call decides accept / reject / needs_more_info (+ reason +
// confidence), judged against the agent's own identity + declared scope. This is the
// capability decision (not a hard subset match): the agent may accept a job it cannot solve
// (worse score) or reject one outside its ability. Runs at boot/refresh, distinct from
// conversation-time acceptance in jobLifecycle.ts. NEVER throws — a model hiccup on a
// template DEFAULTS that template to reject, so a failure never silently OFFERS a job.

import { ModelType } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";

import type { AgentCharacter, AgentCapabilities } from "../character/character.js";
import type { IntakeTemplate } from "./intakeTemplate.js";

// --- Stage 1: the broad platform pre-filter ----------------------------------
// Narrows fetched templates to the agent's declared scope BEFORE self-selection. This is
// NOT the capability decision (that is the self-selection below); it only bounds the
// candidate set. Absent capabilities -> permissive (all candidates). PURE.

/**
 * Keep templates whose `category` is in `capabilities.categories` (when set) AND whose
 * `evaluator_id` exactly equals or starts with one of `capabilities.evaluatorFamilies`
 * (when set). Each constraint applies only when present; absent -> everything. Fresh array.
 */
export function prefilterCandidates(
  templates: readonly IntakeTemplate[],
  capabilities?: AgentCapabilities,
): IntakeTemplate[] {
  if (capabilities === undefined) return [...templates];
  const categories =
    capabilities.categories && capabilities.categories.length > 0
      ? new Set(capabilities.categories)
      : undefined;
  const families =
    capabilities.evaluatorFamilies && capabilities.evaluatorFamilies.length > 0
      ? capabilities.evaluatorFamilies
      : undefined;

  return templates.filter((t) => {
    if (categories !== undefined && !categories.has(t.category)) return false;
    if (families !== undefined && !families.some((f) => t.evaluator_id === f || t.evaluator_id.startsWith(f))) {
      return false;
    }
    return true;
  });
}

// --- Stage 2: the agent's self-selection (the capability decision) -----------

// plugin-groq returns this sentinel instead of throwing; treat it as no decision (-> reject).
const GROQ_ERROR_SENTINEL = "Error generating text. Please try again later.";

// A template is offerable ONLY if the agent accepted it AND was at least this confident.
// "needs_more_info" and low-confidence accepts are NOT offerable (they can become a
// "clarify capability" state later).
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

export type SelfSelectDecision = "accept" | "reject" | "needs_more_info";

export interface TemplateSelection {
  readonly template: IntakeTemplate;
  readonly decision: SelfSelectDecision;
  readonly reason: string;
  readonly confidence: number;
}

export interface SelfSelectInput {
  readonly runtime: IAgentRuntime;
  readonly character: AgentCharacter;
  readonly candidates: readonly IntakeTemplate[];
  /** Minimum confidence for an "accept" to be offerable. Default DEFAULT_CONFIDENCE_THRESHOLD. */
  readonly threshold?: number;
}

export interface SelfSelectResult {
  readonly selections: readonly TemplateSelection[];
  readonly accepted: readonly IntakeTemplate[];
}

// Leak-guarded: the agent reasons over its identity + the template internally; only the
// JSON decision is returned. PURE.
function buildSelfSelectPrompt(character: AgentCharacter, template: IntakeTemplate): string {
  const identity = [`Name: ${character.name}`, ...character.bio.map((b) => `- ${b}`)].join("\n");
  const scopeParts = character.capabilities
    ? [
        character.capabilities.categories
          ? `categories: ${character.capabilities.categories.join(", ")}`
          : "",
        character.capabilities.evaluatorFamilies
          ? `evaluator families: ${character.capabilities.evaluatorFamilies.join(", ")}`
          : "",
      ].filter((s) => s.length > 0)
    : [];
  const scope = scopeParts.length > 0 ? scopeParts.join("; ") : "(none declared)";
  const outputs = Object.entries(template.output).map(([n, t]) => `${n} (${t})`).join(", ");
  const params = Object.entries(template.params).map(([n, p]) => `${n} (${p.type})`).join(", ");
  return [
    "You are an autonomous agent deciding whether to OFFER a job to users. Judge ONLY",
    "whether YOU can do this job well, given your identity and scope below. You have the",
    "final say: accept a job you can do, reject one outside your ability, or needs_more_info",
    "if you genuinely cannot tell yet.",
    "",
    "Your identity:",
    identity,
    `Your declared scope: ${scope}`,
    "",
    "The job:",
    `- what it does: ${template.description}`,
    `- evaluator: ${template.evaluator_id} (category ${template.category})`,
    `- you must produce: ${outputs}`,
    `- you must collect from the user: ${params}`,
    "",
    'Output ONLY a single JSON object: { "decision": "accept"|"reject"|"needs_more_info",',
    '"reason": "<short>", "confidence": <number between 0 and 1> }. No prose, no markdown,',
    "no code fences -- just the raw JSON object.",
    "",
    "JSON object:",
  ].join("\n");
}

// Parse the decision; prose-tolerant ({...} slice), enum-checked, confidence clamped to
// [0,1]. Invalid -> undefined (the caller defaults to reject). PURE.
function parseSelfSelect(
  raw: string,
): { decision: SelfSelectDecision; reason: string; confidence: number } | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const o = parsed as Record<string, unknown>;
  const d = o.decision;
  if (d !== "accept" && d !== "reject" && d !== "needs_more_info") return undefined;
  const reason = typeof o.reason === "string" ? o.reason : "";
  const rawConf = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : 0;
  return { decision: d, reason, confidence: Math.max(0, Math.min(1, rawConf)) };
}

async function selectOne(
  runtime: IAgentRuntime,
  character: AgentCharacter,
  template: IntakeTemplate,
): Promise<{ decision: SelfSelectDecision; reason: string; confidence: number }> {
  let raw: unknown;
  try {
    raw = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: buildSelfSelectPrompt(character, template),
    });
  } catch {
    return { decision: "reject", reason: "self-selection model call failed", confidence: 0 };
  }
  const text = (typeof raw === "string" ? raw : String(raw ?? "")).trim();
  if (text.length === 0 || text === GROQ_ERROR_SENTINEL) {
    return { decision: "reject", reason: "self-selection returned no usable output", confidence: 0 };
  }
  return parseSelfSelect(text) ?? {
    decision: "reject",
    reason: "self-selection output was unparseable",
    confidence: 0,
  };
}

/**
 * Self-select over the pre-filtered candidates: one decision per template. Returns the full
 * selection list (for logging) plus the accepted subset (the offerable menu). NEVER throws.
 */
export async function selfSelectTemplates(input: SelfSelectInput): Promise<SelfSelectResult> {
  const threshold = input.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const families = input.character.capabilities?.evaluatorFamilies;
  const selections: TemplateSelection[] = [];
  for (const template of input.candidates) {
    // An agent that EXPLICITLY declared it serves this evaluator (the `evaluators` binding) offers
    // the matching template DETERMINISTICALLY: the declaration is authoritative, so skip the fragile
    // per-template LLM self-selection (which defaults to REJECT on any non-JSON / low-confidence
    // model output). Discovery agents (no evaluator binding) still let the model decide.
    const bound =
      families !== undefined &&
      template.evaluator_id.length > 0 &&
      families.some((f) => template.evaluator_id === f || template.evaluator_id.startsWith(f));
    const decision = bound
      ? { decision: "accept" as const, reason: "declared evaluator binding", confidence: 1 }
      : await selectOne(input.runtime, input.character, template);
    selections.push({ template, ...decision });
  }
  // Offerable = accepted AND confident enough. needs_more_info / low-confidence are excluded.
  const accepted = selections
    .filter((s) => s.decision === "accept" && s.confidence >= threshold)
    .map((s) => s.template);
  return { selections, accepted };
}
