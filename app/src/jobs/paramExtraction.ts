// paramExtraction.ts — extract the job-parameter VALUES the user gave from the chat
// transcript, keyed by a template's param names, via ONE leak-guarded structured useModel
// call. The job-lifecycle coordinator uses this to decide when every required param is in.

import { ModelType } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";

import { flattenTranscript } from "../session/closeSession.js";
import type { ChatTurn } from "../chat/chatMemory.js";
import type { IntakeTemplate } from "../templates/intakeTemplate.js";

// plugin-groq returns this sentinel instead of throwing; treat it as a hard extraction failure
// so we never act on a fake extraction.
const GROQ_ERROR_SENTINEL = "Error generating text. Please try again later.";

// Leak-guarded structured prompt: it reasons over the template's param names internally, but
// the OUTPUT is a flat JSON object of name -> value (or null when not yet given). Pure.
function buildExtractionPrompt(template: IntakeTemplate, transcript: string): string {
  const paramLines = Object.entries(template.params)
    .map(([name, p]) => `  - ${name} (${p.type}): asked as "${p.ask}"`)
    .join("\n");
  return [
    "From the conversation below, extract the value the user gave for each job",
    "parameter. Output ONLY a single JSON object mapping each parameter name to the",
    "user's value as a string, or null if the user has not given it yet. No prose, no",
    "markdown, no code fences -- just the raw JSON object.",
    "",
    "Parameters to extract:",
    paramLines,
    "",
    "Conversation:",
    transcript,
    "",
    "JSON object:",
  ].join("\n");
}

// Parse the model output into a name -> value map, tolerating a fenced/prose-wrapped reply by
// slicing the first {...} span. Unknown/invalid shapes yield an empty map (best-effort). Pure.
function parseExtractedParams(raw: string): Record<string, string> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const entries = Object.entries(parsed as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
    .map(([k, v]) => [k, (v as string).trim()] as const);
  return Object.fromEntries(entries);
}

export type ExtractParamsResult =
  | { ok: true; collected: Record<string, string> }
  // The extraction model call returned empty / the groq sentinel. Retryable.
  | { ok: false; reason: "model_error"; message: string };

/**
 * Extract the collected parameter values from the transcript via ONE leak-guarded structured
 * useModel call. Returns ok:true + the best-effort name->value map, or ok:false model_error
 * when the call returns empty / the groq sentinel. Does NOT catch a useModel exception (it
 * propagates) — defensive callers wrap this.
 */
export async function extractCollectedParams(
  runtime: IAgentRuntime,
  template: IntakeTemplate,
  turns: readonly ChatTurn[],
): Promise<ExtractParamsResult> {
  const transcript = flattenTranscript(turns);
  const raw = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: buildExtractionPrompt(template, transcript),
  });
  const text = (typeof raw === "string" ? raw : String(raw ?? "")).trim();
  if (text.length === 0 || text === GROQ_ERROR_SENTINEL) {
    return {
      ok: false,
      reason: "model_error",
      message: text === GROQ_ERROR_SENTINEL ? "groq error sentinel" : "empty response",
    };
  }
  return { ok: true, collected: parseExtractedParams(text) };
}
