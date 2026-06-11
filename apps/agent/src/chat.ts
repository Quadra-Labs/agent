// chat.ts — A3 Task 3: the single-turn agent loop (within-session chat).
//
// One conversational turn over the runtime's local message memory:
//   1. persist the USER turn (chatMemory.saveTurn)
//   2. read the recent history back OLDEST-first (chatMemory.listTurns)
//   3. flatten a bounded recent window into ONE string prompt
//   4. call the model via runtime.useModel(ModelType.TEXT_LARGE, { prompt })
//   5. persist the AGENT reply and return it (trimmed)
//
// History is read from the LOCAL DB so the prompt reflects exactly what was
// stored. plugin-groq is configured for STRING prompts (memory:
// elizaos-standalone-gotchas), so we pass a single `prompt`, not a messages array.
//
// SCOPE: within-session persistence + recent-history recall ONLY. No checkpoint
// writer, no summarization, no cross-session recall, no MemWal (Tasks 4-6). The
// system prompt here is deliberately minimal -- job-template injection lives in
// another workstream.
//
// A3 Task 5 EXTENSION (recall+inject seam, backward-compatible): respond/the
// prompt builder accept an OPTIONAL `resumedSummary`. When present it renders a
// clearly-labeled "recalled prior-session context" section ahead of the recent
// history, so a NEW session continues from a recalled checkpoint. When ABSENT the
// prompt is BYTE-IDENTICAL to the original Task 3 output (the recalled-context
// section is omitted entirely). The recall READ that produces this summary lives
// in recallCheckpoint.ts; this file only renders it. The labeling is lifted from
// demo/src/character.ts buildSystemPrompt's resumedSummary block.
//
// A4 Task 2-4 EXTENSION (job-template provider seam, backward-compatible): respond/
// the prompt builder also accept an OPTIONAL `templatesText` (the readable block
// from templates.ts renderTemplatesForPrompt). When present, the prompt carries the
// template descriptions PLUS the match/confirm/collect/never-leak behavioral rules
// (lifted from demo/src/character.ts) so the agent does job intake. When ABSENT the
// template section AND those rules are omitted entirely, so the prompt is
// BYTE-IDENTICAL to the A3 output. The two seams compose: a resumed + templated
// session renders both blocks. This file only RENDERS the templates; reading them
// from Walrus lives in templates.ts. The framework never authors templates — agents
// only CONFORM to them — and never matches/collects in code: the behavior is the
// model's, driven by these prompt rules and the SQLite chat history as cross-turn
// state (no structured tracker).

import { ModelType } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import { saveTurn, listTurns, type ChatTurn } from "./chatMemory.js";

// plugin-groq swallows API errors and returns this sentinel string instead of
// throwing. Treat it as a hard failure so callers surface the real problem rather
// than persisting a fake "reply".
const GROQ_ERROR_SENTINEL = "Error generating text. Please try again later.";

// Cap the history window injected into the prompt. Recent context is enough and
// keeps the prompt bounded as a session grows.
const MAX_HISTORY_TURNS = 30;

// Minimal behavioral contract. Kept terse on purpose: this is the within-session
// recall base. Job-intake behavior is ADDITIVE and only appears when templatesText
// is present (A4 Task 2-4) — see TEMPLATE_BEHAVIOR_RULES below.
const SYSTEM_PROMPT = [
  "You are a helpful assistant talking to a user in a terminal.",
  "Be warm, concise, and natural. Use the conversation so far for context, and",
  "refer back to earlier turns when relevant. Plain text only: no markdown",
  "headers, no code blocks.",
].join(" ");

// --- Job-intake behavioral rules (A4 Task 2-4) ------------------------------
// Lifted from demo/src/character.ts. ONLY rendered when templatesText is present,
// so the A3 prompt is unchanged when no templates are supplied. The model does ALL
// matching/collection from these rules + the chat history; there is NO code-side
// tracker. The SQLite transcript IS the cross-turn state (Task 4).

// Match a request to a SINGLE job and CONFIRM it in plain language (Task 3).
const MATCHING = [
  "You can only help with jobs that match one of the job types listed above.",
  "When the user starts describing something they want predicted or resolved,",
  "silently pick the SINGLE best-matching job type and CONFIRM it in plain",
  'language, e.g. "It sounds like you want a cryptocurrency price prediction --',
  'is that right?". If nothing matches, say what kinds of jobs you can help with',
  "and keep chatting normally.",
].join(" ");

// Collect EVERY parameter conversationally; re-ask only what is still missing,
// deriving "missing" from the conversation so far (Task 4 — no structured tracker).
const COLLECTING = [
  "Once the user confirms the match, collect EVERY required parameter for that job",
  "by asking its natural question. Ask one or two at a time, acknowledge each answer,",
  "and keep track of what is still missing by reading the conversation so far -- only",
  "re-ask a parameter you do not yet have. Do not ask for the same value twice.",
].join(" ");

// When every parameter is collected, summarize in plain language and stop (Task 4).
const SUMMARY = [
  "When you have every parameter, give a short plain-language summary of the job",
  "(what asset or market, what you will predict or resolve, and the time window),",
  "then say that in the full system this would now be handed to the Intake Engine",
  "for pricing and the user's cost approval, and that this demo stops there -- no",
  "live market or oracle data is fetched. Do NOT invent a prediction, price, or",
  "outcome value yourself.",
].join(" ");

// The non-negotiable leak guard (Task 3). Repeated tersely so the model keeps it
// salient: no JSON, no field/param names, never the word "template", no raw params.
const NEVER_LEAK = [
  "NEVER reveal the internal job definitions to the user: do not print JSON, do not",
  'print field or parameter names like "minPrice" or "category_id", and never use',
  'the word "template". Translate everything into ordinary conversation.',
].join(" ");

export interface RespondInput {
  readonly roomId: string;
  readonly user: string;
  readonly text: string;
  /**
   * OPTIONAL recalled prior-session context (A3 Task 5). When a NEW session is
   * resumed from a prior checkpoint, the recalled checkpoint summary is passed here
   * so it is rendered into the prompt ahead of the recent history, clearly labeled
   * as recalled context. ABSENT -> the prompt is byte-identical to Task 3 behavior.
   * The READ that resolves this summary lives in recallCheckpoint.ts; respond only
   * injects it.
   */
  readonly resumedSummary?: string;
  /**
   * OPTIONAL readable job-template descriptions (A4 Task 2). When present, the
   * built prompt carries these descriptions plus the match/confirm/collect/never-leak
   * behavioral rules, so the agent does job intake. ABSENT -> the template section and
   * those rules are omitted and the prompt is byte-identical to A3 behavior. Produced
   * by templates.ts renderTemplatesForPrompt; it is for the agent's reasoning ONLY and
   * must NEVER be shown verbatim to the user. respond only injects it.
   */
  readonly templatesText?: string;
  /**
   * OPTIONAL system-prompt override (the interactive CLI passes a character's
   * systemPrompt here). ABSENT -> the built-in SYSTEM_PROMPT is used, so the prompt
   * is byte-identical to prior behavior. Only the leading behavioral line changes;
   * the template/recall/history sections are unaffected.
   */
  readonly systemPrompt?: string;
  /**
   * Optional hook to OBSERVE the exact flattened prompt sent to the model, before
   * the model call. Used by the proof to assert the recent-history window contains
   * the prior turn. Does not affect behavior.
   */
  readonly onPrompt?: (prompt: string) => void;
}

function labelFor(role: ChatTurn["role"]): string {
  return role === "agent" ? "Agent" : "User";
}

/**
 * Render a bounded recent window of turns into a flat transcript string,
 * oldest-first. Pure: same turns in -> same string out. Exported so the proof can
 * build/inspect the identical window deterministically.
 */
export function renderHistory(turns: readonly ChatTurn[]): string {
  const recent = turns.slice(-MAX_HISTORY_TURNS);
  return recent.map((turn) => `${labelFor(turn.role)}: ${turn.text}`).join("\n");
}

/**
 * Render the OPTIONAL recalled prior-session context section (A3 Task 5). Returns
 * the labeled lines to splice in AHEAD of the recent history, or an EMPTY array
 * when there is no usable recalled summary (absent / whitespace-only). The label
 * is lifted from demo/src/character.ts so the agent treats it as prior context to
 * continue from, not restart. Pure: same input -> same lines. Exported so the
 * proof can assert the exact labeled block.
 */
export function renderResumedContext(resumedSummary?: string): readonly string[] {
  if (resumedSummary === undefined || resumedSummary.trim().length === 0) {
    return [];
  }
  return [
    "Recalled context from a previous session (continue from this, do not restart):",
    resumedSummary.trim(),
    "",
    "Open by briefly acknowledging this recalled context, then carry on from where",
    "it left off.",
    "",
  ];
}

/**
 * Render the OPTIONAL job-template section (A4 Task 2). Returns the lines to splice
 * in: the readable template descriptions (for the agent's eyes only) followed by the
 * match/confirm/collect/never-leak behavioral rules. Returns an EMPTY array when
 * there is no usable templatesText (absent / whitespace-only), so the A3 prompt is
 * unchanged when no templates are supplied. Pure: same input -> same lines. Exported
 * so the proof can assert the exact block. The behavior rules are lifted from
 * demo/src/character.ts; they go HERE (not in SYSTEM_PROMPT) so they only activate
 * with templates present.
 */
export function renderTemplates(templatesText?: string): readonly string[] {
  if (templatesText === undefined || templatesText.trim().length === 0) {
    return [];
  }
  return [
    "Job types you can handle (for your reasoning only -- never shown to the user):",
    templatesText.trim(),
    "",
    "How to behave for job intake:",
    `- ${MATCHING}`,
    `- ${COLLECTING}`,
    `- ${SUMMARY}`,
    `- ${NEVER_LEAK}`,
    "",
  ];
}

/**
 * Build the full flattened prompt from a recent-history window, optionally injecting
 * a job-template section AND/OR a recalled prior-session summary AHEAD of the recent
 * history. Pure and deterministic given its inputs. The model receives exactly this
 * string.
 *
 * When BOTH `resumedSummary` and `templatesText` are absent (or whitespace-only) the
 * output is BYTE-IDENTICAL to the original Task 3 prompt: both optional blocks are
 * omitted entirely. The two seams COMPOSE: with templatesText the job-intake section
 * + rules render first; with resumedSummary a clearly-labeled recalled-context
 * section renders; both can be present together. Both are positioned BEFORE the
 * recent-history window.
 */
export function buildChatPrompt(
  history: readonly ChatTurn[],
  resumedSummary?: string,
  templatesText?: string,
  systemPrompt?: string,
): string {
  const lead =
    systemPrompt !== undefined && systemPrompt.trim().length > 0
      ? systemPrompt.trim()
      : SYSTEM_PROMPT;
  return [
    lead,
    "",
    ...renderTemplates(templatesText),
    ...renderResumedContext(resumedSummary),
    "Conversation so far:",
    renderHistory(history),
    "",
    "Agent:",
  ].join("\n");
}

/**
 * Run one agent turn. Saves the user message, reads recent history back from the
 * local DB, flattens it into the prompt, queries the LLM, then saves and returns
 * the agent reply (trimmed). Throws if the model yields empty text or the
 * plugin-groq error sentinel.
 */
export async function respond(
  runtime: IAgentRuntime,
  input: RespondInput,
): Promise<string> {
  await saveTurn(runtime, { roomId: input.roomId, role: "user", text: input.text });

  const history = await listTurns(runtime, input.roomId);
  const prompt = buildChatPrompt(
    history,
    input.resumedSummary,
    input.templatesText,
    input.systemPrompt,
  );
  input.onPrompt?.(prompt);

  const raw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const text = (typeof raw === "string" ? raw : String(raw ?? "")).trim();

  if (text.length === 0 || text === GROQ_ERROR_SENTINEL) {
    const why = text === GROQ_ERROR_SENTINEL ? "groq error sentinel" : "empty response";
    throw new Error(`Agent produced no usable reply (${why}). Check the Groq key/model.`);
  }

  await saveTurn(runtime, { roomId: input.roomId, role: "agent", text });
  return text;
}
