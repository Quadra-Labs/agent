// toolLoop.ts — the LLM tool-calling loop over the framework's model seam (so it works
// with whatever provider the host configured). Each iteration prompts, parses the
// emission, and either executes a {"tool","arguments"} call through the MCP port (append
// observation, iterate) or returns the final plain-text answer.
//
// A TOOL failure is information for the model (an error observation it can recover from),
// never a turn crash; a malformed call is fed back as INVALID TOOL MESSAGE; only a
// MODEL-SEAM throw propagates. Budgets: maxToolCalls executions (5), maxModelCalls
// interactive round-trips (8); on exhaustion ONE forced-final prompt runs OUTSIDE the
// budget (worst case = maxModelCalls + 1), reported via ToolLoopResult.forcedFinal.
// The transcript is EPHEMERAL — only the user+agent reply pair is persisted.

import type { ChatTurn } from "../../../app/src/chatMemory.js";
import type { LoopModel } from "../session/loopContext.js";
import type { ToolPort } from "./toolServer.js";
import {
  buildToolLoopPrompt,
  buildForcedFinalPrompt,
  type ToolPromptInput,
  type ToolTranscriptEntry,
} from "./toolPrompt.js";

export type { ToolTranscriptEntry } from "./toolPrompt.js";

/** Loop budgets. Both default when omitted; see DEFAULT_LIMITS. */
export interface ToolLoopLimits {
  /** Max tool EXECUTIONS (successful or failed) before forcing a final answer. */
  readonly maxToolCalls?: number;
  /** Max INTERACTIVE model round-trips (calls + protocol-error retries). The one
   *  forced-final prompt issued on exhaustion is NOT counted against this budget,
   *  so the worst-case total model calls is maxModelCalls + 1. */
  readonly maxModelCalls?: number;
}

/** Everything one tool-loop run needs. Mirrors DefaultReplyInput's optional seams. */
export interface ToolLoopInput {
  readonly model: LoopModel;
  readonly port: ToolPort;
  readonly userMessage: string;
  readonly history: readonly ChatTurn[];
  readonly recalledContext?: string;
  readonly templatesText?: string;
  readonly systemPrompt?: string;
  /** Observe every prompt sent to the model (per round-trip), for proofs/logging. */
  readonly onPrompt?: (prompt: string) => void;
  readonly limits?: ToolLoopLimits;
}

/** What a tool-loop run produced: the reply, the audit trail, and whether the
 *  budgets forced the answer. */
export interface ToolLoopResult {
  readonly text: string;
  readonly transcript: readonly ToolTranscriptEntry[];
  readonly forcedFinal: boolean;
}

const DEFAULT_LIMITS = { maxToolCalls: 5, maxModelCalls: 8 } as const;

/** What parseModelEmission decides a model emission was. */
export type ModelEmission =
  | { readonly kind: "tool_call"; readonly toolName: string; readonly args: Record<string, unknown> }
  | { readonly kind: "final"; readonly text: string }
  | { readonly kind: "protocol_error"; readonly raw: string; readonly reason: string };

// Strip ONE wrapping markdown fence pair (``` or ```json ... ```). Models add fences
// despite instructions; the content inside is what the contract describes.
function stripFence(text: string): string {
  const match = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(text);
  return match !== undefined && match !== null ? match[1].trim() : text;
}

// Extract the first balanced {...} (depth scan, string/escape-aware). undefined if none.
function extractFirstObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

/**
 * Decide what the model's emission was (PURE; exported for table-driven tests): a parsed
 * object with a string `tool` is a tool_call (tolerated even with prose on either side,
 * since models pad calls); missing/null args -> {}, non-object args -> protocol_error; a
 * JSON object without `tool` or plain prose is the final answer; an unparseable but
 * tool-ish emission is a protocol_error fed back for correction.
 */
export function parseModelEmission(raw: string): ModelEmission {
  const text = stripFence(raw.trim());
  const startsWithBrace = text.startsWith("{");

  // Parse the whole text when it IS the object, else the first balanced {...}.
  let parsed: unknown;
  if (startsWithBrace) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (parsed === undefined) {
    const candidate = extractFirstObject(text);
    if (candidate !== undefined) {
      try {
        parsed = JSON.parse(candidate);
      } catch {
        parsed = undefined;
      }
    }
  }

  if (parsed !== undefined && parsed !== null && typeof parsed === "object") {
    const obj = parsed as { tool?: unknown; arguments?: unknown };
    if (typeof obj.tool === "string") {
      const args = obj.arguments ?? {};
      if (typeof args !== "object" || Array.isArray(args)) {
        return {
          kind: "protocol_error",
          raw: text,
          reason: '"arguments" must be a JSON object',
        };
      }
      return {
        kind: "tool_call",
        toolName: obj.tool,
        args: args as Record<string, unknown>,
      };
    }
    // A JSON object without a `tool` key: only an emission that IS that object reads
    // as the model "answering in JSON" -> final. Plain prose that merely CONTAINS some
    // non-tool object is also final (the prose is the answer).
    return { kind: "final", text };
  }

  // Nothing parseable. An emission that starts with "{", or that has JSON-ish braces
  // AND names "tool", tried to be a call and failed -> feed the protocol error back.
  // Plain prose that merely quotes the word "tool" (no braces) is a final answer.
  const mentionsTool = text.includes('"tool"') || text.includes("'tool'");
  if (startsWithBrace || (text.includes("{") && mentionsTool)) {
    return {
      kind: "protocol_error",
      raw: text,
      reason: "looked like a tool call but was not valid JSON",
    };
  }
  return { kind: "final", text };
}

/**
 * Run the tool loop for one turn and return the final reply text + the audit
 * transcript. Never throws for tool/protocol failures (they become observations the
 * model reacts to); a model-seam throw propagates to the rail like today.
 */
export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const maxToolCalls = input.limits?.maxToolCalls ?? DEFAULT_LIMITS.maxToolCalls;
  const maxModelCalls = input.limits?.maxModelCalls ?? DEFAULT_LIMITS.maxModelCalls;

  const transcript: ToolTranscriptEntry[] = [];
  let toolCalls = 0;
  let modelCalls = 0;

  const promptInput = (): ToolPromptInput => ({
    descriptors: input.port.list(),
    history: input.history,
    userMessage: input.userMessage,
    transcript,
    recalledContext: input.recalledContext,
    templatesText: input.templatesText,
    systemPrompt: input.systemPrompt,
  });

  while (toolCalls < maxToolCalls && modelCalls < maxModelCalls) {
    const prompt = buildToolLoopPrompt(promptInput());
    input.onPrompt?.(prompt);
    modelCalls += 1;
    const emission = await input.model.generate(prompt);
    const decision = parseModelEmission(emission);

    if (decision.kind === "final") {
      return { text: decision.text, transcript, forcedFinal: false };
    }

    if (decision.kind === "protocol_error") {
      transcript.push({
        kind: "protocol_error",
        raw: decision.raw,
        reason: decision.reason,
      });
      continue; // retry, bounded by maxModelCalls
    }

    // A tool call: record it, execute it through the in-process MCP port, and feed
    // the observation (success value or typed error) back to the model.
    toolCalls += 1;
    const argsJson = JSON.stringify(decision.args);
    transcript.push({ kind: "call", toolName: decision.toolName, argsJson });
    const outcome = await input.port.call(decision.toolName, decision.args);
    const resultJson = outcome.ok
      ? JSON.stringify(outcome.value === undefined ? null : outcome.value)
      : JSON.stringify({ error: outcome.error.kind, message: outcome.error.message });
    // Simple visibility: every LLM-driven tool call is logged with the function name,
    // the arguments the model chose, and the raw outcome (value or typed error).
    console.log(`[tool] ${decision.toolName} ${argsJson} -> ${resultJson}`);
    transcript.push({
      kind: "observation",
      toolName: decision.toolName,
      resultJson,
    });
  }

  // Budgets exhausted: ONE forced-final prompt; its output is the answer, verbatim.
  const finalPrompt = buildForcedFinalPrompt(promptInput());
  input.onPrompt?.(finalPrompt);
  const forced = await input.model.generate(finalPrompt);
  return { text: stripFence(forced.trim()), transcript, forcedFinal: true };
}
