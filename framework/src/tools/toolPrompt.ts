// toolPrompt.ts — pure prompt builders for the tool loop. The model seam is text-only,
// so "the LLM decides when to run a tool" is a PROMPT PROTOCOL: the prompt advertises
// tools (name + description + the server's JSON Schema) and a strict output contract —
// a single-line {"tool","arguments"} object to call, or plain text NOT starting with
// "{" as the final answer (the "{"-rule gives the parser a clean first-char split).
// Section order + renderers are shared with buildChatPrompt. Accepted v1 caveat:
// observations render into the prompt (prompt-injection at the same trust level as a
// skill output an onTurn renders).

import {
  renderHistory,
  renderResumedContext,
  renderTemplates,
} from "../../../app/src/chat/chat.js";
import type { ChatTurn } from "../../../app/src/chat/chatMemory.js";
import type { ToolDescriptor } from "./toolServer.js";

// The default lead when the agent declares no systemPrompt.
const DEFAULT_LEAD = [
  "You are a helpful assistant talking to a user in a terminal.",
  "Be warm, concise, and natural. Plain text only: no markdown headers, no code",
  "blocks. You can run tools to get real data before answering.",
].join(" ");

/** A distinctive protocol line, exported so proofs can recognize a tool-loop prompt. */
export const TOOL_PROTOCOL_MARKER =
  'To call a tool, reply with EXACTLY one single-line JSON object and NOTHING else:';

/** One entry of the tool session so far, rendered back into every subsequent prompt. */
export type ToolTranscriptEntry =
  | { readonly kind: "call"; readonly toolName: string; readonly argsJson: string }
  | { readonly kind: "observation"; readonly toolName: string; readonly resultJson: string }
  | { readonly kind: "protocol_error"; readonly raw: string; readonly reason: string };

/** Everything the prompt builders need for one model call of the loop. */
export interface ToolPromptInput {
  readonly descriptors: readonly ToolDescriptor[];
  readonly history: readonly ChatTurn[];
  readonly userMessage: string;
  readonly transcript: readonly ToolTranscriptEntry[];
  readonly recalledContext?: string;
  readonly templatesText?: string;
  readonly systemPrompt?: string;
}

/** Render the advertised tools block (the server's own JSON Schema, one per tool). */
export function renderToolDescriptors(
  descriptors: readonly ToolDescriptor[],
): string {
  return descriptors
    .map(
      (d) =>
        `- tool: ${d.name}\n` +
        `  description: ${d.description}\n` +
        `  input_schema: ${JSON.stringify(d.inputSchema)}`,
    )
    .join("\n");
}

// Cap per observation line so a huge tool result doesn't compound across loop prompts.
// The transcript keeps the full value; only the prompt rendering is capped.
const MAX_OBSERVATION_RENDER_CHARS = 16_000;

function capForPrompt(json: string): string {
  if (json.length <= MAX_OBSERVATION_RENDER_CHARS) {
    return json;
  }
  return `${json.slice(0, MAX_OBSERVATION_RENDER_CHARS)} ...[truncated: ${json.length} chars total]`;
}

/** Render the tool session so far, oldest-first (empty when nothing happened yet). */
export function renderToolTranscript(
  transcript: readonly ToolTranscriptEntry[],
): readonly string[] {
  if (transcript.length === 0) {
    return [];
  }
  const lines = transcript.map((entry) => {
    switch (entry.kind) {
      case "call":
        return `TOOL CALL: {"tool":${JSON.stringify(entry.toolName)},"arguments":${entry.argsJson}}`;
      case "observation":
        return `OBSERVATION (${entry.toolName}): ${capForPrompt(entry.resultJson)}`;
      case "protocol_error":
        return `INVALID TOOL MESSAGE (${entry.reason}): ${capForPrompt(entry.raw)}`;
    }
  });
  return ["Tool session so far (this turn):", ...lines, ""];
}

// The protocol contract the parser relies on. The "only when needed" rule is
// load-bearing: without it models over-apply a tool recipe to every message.
function protocolInstructions(): readonly string[] {
  return [
    TOOL_PROTOCOL_MARKER,
    '{"tool": "<tool_name>", "arguments": { ... values matching the tool\'s input_schema ... }}',
    "Do not wrap it in markdown fences. Do not add any text before or after it.",
    "After each tool call you will receive an OBSERVATION with the tool's result as JSON.",
    "You may call tools several times (one call per reply).",
    "Call a tool ONLY when its result is needed to answer the user's CURRENT message.",
    "If the message is conversational, a follow-up about something you already said",
    "(such as how you got an answer), or answerable from the conversation so far,",
    "reply directly with plain text and do NOT call any tool.",
    "When you have enough information, reply with your final answer to the user as",
    'plain text. The final answer must NOT be JSON and must NOT start with "{".',
    "",
  ];
}

// The prompt head: lead + the advertised tools block.
function headSections(input: ToolPromptInput): readonly string[] {
  const lead =
    input.systemPrompt !== undefined && input.systemPrompt.trim().length > 0
      ? input.systemPrompt.trim()
      : DEFAULT_LEAD;
  return [
    lead,
    "",
    "You can use tools to answer. The available tools are:",
    renderToolDescriptors(input.descriptors),
    "",
  ];
}

// The prompt tail: templates, recalled context, the conversation, the transcript.
function tailSections(input: ToolPromptInput): readonly string[] {
  // EFFECTIVE history = stored turns + the current user message, mirroring
  // defaultTurn.ts (renderHistory keys only on role+text; createdAt is ordinal).
  const effective: readonly ChatTurn[] = [
    ...input.history,
    { role: "user", text: input.userMessage, createdAt: input.history.length + 1 },
  ];
  return [
    ...renderTemplates(input.templatesText),
    ...renderResumedContext(input.recalledContext),
    "Conversation so far:",
    renderHistory(effective),
    "",
    ...renderToolTranscript(input.transcript),
  ];
}

/**
 * Build one tool-loop prompt: the full protocol (tools, instructions, conversation,
 * transcript) ending on the dual cue — a single-line JSON tool call, or the final
 * plain-text answer.
 */
export function buildToolLoopPrompt(input: ToolPromptInput): string {
  return [
    ...headSections(input),
    ...protocolInstructions(),
    ...tailSections(input),
    "Your reply (one single-line JSON tool call, or your final plain-text answer):",
  ].join("\n");
}

/**
 * Build the FORCED-FINAL prompt, issued once when the loop's budgets are exhausted:
 * identical context, but the call instructions are replaced by a hard stop so the
 * model must answer the user from what it has.
 */
export function buildForcedFinalPrompt(input: ToolPromptInput): string {
  return [
    ...headSections(input),
    ...tailSections(input),
    "You cannot call any more tools. Using the observations above, write your final",
    "plain-text answer to the user now. Do not output JSON.",
    "",
    "Your final answer:",
  ].join("\n");
}
