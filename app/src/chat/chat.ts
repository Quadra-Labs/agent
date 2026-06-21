// chat.ts — the single-turn agent loop: persist the user turn, flatten recent local
// history into ONE string prompt, call the model, persist and return the reply.
// plugin-groq is configured for STRING prompts: pass a single `prompt`, not messages.
// When resumedSummary/templatesText are absent the prompt is BYTE-IDENTICAL to the base output.

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

// The base within-session contract. Job-intake behavior is additive (rendered only
// with templatesText), so this prompt is unchanged when no templates are supplied.
const SYSTEM_PROMPT = [
  "You are a helpful assistant talking to a user in a terminal.",
  "Be warm, concise, and natural. Use the conversation so far for context, and",
  "refer back to earlier turns when relevant. Plain text only: no markdown",
  "headers, no code blocks.",
].join(" ");

// Job-intake behavioral rules, rendered ONLY when templatesText is present. The model
// does all matching/collection from these + the chat history (no code-side tracker;
// the SQLite transcript is the cross-turn state).

// Match a request to a SINGLE job and confirm it in plain language.
const MATCHING = [
  "You can only help with jobs that match one of the job types listed above.",
  "When the user starts describing something they want predicted or resolved,",
  "silently pick the SINGLE best-matching job type and CONFIRM it in plain",
  'language, e.g. "It sounds like you want a cryptocurrency price prediction --',
  'is that right?". If nothing matches, say what kinds of jobs you can help with',
  "and keep chatting normally.",
].join(" ");

// Collect every parameter conversationally; re-ask only what is still missing.
const COLLECTING = [
  "Once the user confirms the match, collect EVERY required parameter for that job",
  "by asking its natural question. Ask one or two at a time, acknowledge each answer,",
  "and keep track of what is still missing by reading the conversation so far -- only",
  "re-ask a parameter you do not yet have. Do not ask for the same value twice.",
].join(" ");

// Proactively surface a matching job instead of waiting to be asked.
const PROACTIVE_OFFER = [
  "Be proactive: at a natural moment -- when the user describes a goal that resembles a job",
  "you can do, or asks what you can help with -- briefly OFFER the single best-matching job",
  "in plain language and invite them to go ahead. Do not wait to be asked, and do not list",
  "internal details.",
].join(" ");

// Encourage completion: ask only for the still-missing details so the job can be finished.
const ASK_FOR_MISSING = [
  "Encourage the user toward a complete job: when they have given some of a job's details",
  "but not all, acknowledge what you already have and ask ONLY for the specific details",
  "still missing, one or two at a time, until you can complete it.",
].join(" ");

// When every parameter is collected: summarize, quote the price, and hand off to the REAL
// payment-first lifecycle. This is NOT a demo — the system opens a real job and produces the
// result from live data AFTER payment, so the agent must never fake progress or invent a value.
const SUMMARY = [
  "When you have every parameter, give a short plain-language summary of the job",
  "(what asset or market, what you will predict or resolve, and the time window) and",
  "state the price. The job is then opened and the user must PAY to start it; the result",
  "is produced from live market/oracle data ONLY AFTER their payment confirms.",
  "Do NOT claim the job is paid, started, running, or in progress; do NOT say you are",
  "gathering, fetching, computing, or producing the result; and do NOT invent a prediction,",
  "price, band, or outcome yourself. After accepting, tell the user to pay to start, then wait.",
].join(" ");

// The non-negotiable leak guard: no JSON, no field/param names, never "template".
const NEVER_LEAK = [
  "NEVER reveal the internal job definitions to the user: do not print JSON, do not",
  'print field or parameter names like "minPrice" or "category_id", and never use',
  'the word "template". Translate everything into ordinary conversation.',
].join(" ");

export interface RespondInput {
  readonly roomId: string;
  readonly user: string;
  readonly text: string;
  /** OPTIONAL recalled prior-session summary, rendered ahead of history (absent ->
   *  byte-identical to the base prompt). Resolved by recallCheckpoint.ts. */
  readonly resumedSummary?: string;
  /** OPTIONAL job-template descriptions; when present the prompt adds them + the
   *  intake rules. For the agent's reasoning ONLY — never shown verbatim. */
  readonly templatesText?: string;
  /** OPTIONAL system-prompt override (a character's systemPrompt); absent -> SYSTEM_PROMPT. */
  readonly systemPrompt?: string;
  /** Optional hook to observe the exact flattened prompt before the model call. */
  readonly onPrompt?: (prompt: string) => void;
}

function labelFor(role: ChatTurn["role"]): string {
  return role === "agent" ? "Agent" : "User";
}

/** Render a bounded recent window of turns into a flat transcript, oldest-first. Pure. */
export function renderHistory(turns: readonly ChatTurn[]): string {
  const recent = turns.slice(-MAX_HISTORY_TURNS);
  return recent.map((turn) => `${labelFor(turn.role)}: ${turn.text}`).join("\n");
}

/** Render the recalled prior-session block (empty when no usable summary). Pure. */
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

/** Render the job-template section + intake rules (empty when no templatesText, so the
 *  base prompt is unchanged). For the agent's reasoning only. Pure. */
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
    `- ${PROACTIVE_OFFER}`,
    `- ${COLLECTING}`,
    `- ${ASK_FOR_MISSING}`,
    `- ${SUMMARY}`,
    `- ${NEVER_LEAK}`,
    "",
  ];
}

/** Build the full flattened prompt: lead, optional template + recalled-context blocks
 *  (both ahead of history), then the recent-history window. Pure; both optional blocks
 *  absent -> byte-identical to the base prompt. */
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

/** Run one agent turn: save the user message, build the prompt from recent history,
 *  query the LLM, save and return the trimmed reply. Throws on empty/sentinel output. */
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
