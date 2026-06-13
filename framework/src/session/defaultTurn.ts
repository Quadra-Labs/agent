// defaultTurn.ts — the SAVE-FREE halves of the default turn: defaultReplyText (text
// only, no saves) and persistTurnPair (user then agent, ONCE, after a successful
// reply — a thrown turn persists nothing, so there is never an orphan user turn).
// INVARIANT: the default prompt stays byte-identical to the original respond() —
// effective history = stored turns + the current user message, rebuilt in memory.

import type { IAgentRuntime } from "@elizaos/core";

import { buildChatPrompt } from "../../../app/src/chat/chat.js";
import {
  saveTurn,
  listTurns,
  type ChatTurn,
} from "../../../app/src/chat/chatMemory.js";
import type { LoopModel, TurnResult } from "./loopContext.js";

/** Inputs for the default reply text. No persistence happens here. */
export interface DefaultReplyInput {
  readonly roomId: string;
  readonly user: string;
  /** The user's message text for THIS turn — appended to the effective history. */
  readonly userMessage: string;
  readonly resumedSummary?: string;
  readonly templatesText?: string;
  readonly systemPrompt?: string;
  readonly onPrompt?: (prompt: string) => void;
  /** The session model: the agent's provider chain, or the sealed runtime wrapper. */
  readonly model: LoopModel;
}

/**
 * Produce the DEFAULT reply text for one turn — SAVE-FREE. Builds the effective history
 * (stored turns + the current user message), builds the prompt via buildChatPrompt with
 * byte-identical inputs, observes it via onPrompt, calls the model, and returns the
 * trimmed reply. Throws on an empty result or the groq error sentinel (mirroring chat.ts)
 * so a model failure surfaces rather than being saved. Persistence is the rail's job
 * (persistTurnPair), done once after this returns.
 */
export async function defaultReplyText(
  runtime: IAgentRuntime,
  input: DefaultReplyInput,
): Promise<string> {
  const stored = await listTurns(runtime, input.roomId);
  // The current user message as it WOULD have been stored in M1 (role+text are all the
  // prompt builder reads; the synthetic createdAt only keeps it last in order).
  const currentUserTurn: ChatTurn = {
    role: "user",
    text: input.userMessage,
    createdAt: stored.length + 1,
  };
  const effective: readonly ChatTurn[] = [...stored, currentUserTurn];

  const prompt = buildChatPrompt(
    effective,
    input.resumedSummary,
    input.templatesText,
    input.systemPrompt,
  );
  input.onPrompt?.(prompt);

  // The LoopModel contract trims and hard-throws on empty/sentinel output, so a model
  // failure surfaces instead of being persisted as a fake reply.
  return input.model.generate(prompt);
}

/**
 * Reject an invalid TurnResult BEFORE it reaches persistence. TypeScript protects
 * honest code, but developer-authored onTurn can cast, return undefined, return a
 * raw string, or return an empty/whitespace `text`. Validating here means the rail
 * never writes a garbage turn to SQLite (and, composed with persist-once-after-reply,
 * an invalid result throws and persists NOTHING — no orphan user turn). Throws a clear
 * Error naming the problem; the caller (session.turn) lets it propagate as a turn
 * failure. Pure (no I/O). Asserts the result is the expected { text, source } shape.
 */
export function assertValidTurnResult(result: unknown): asserts result is TurnResult {
  if (
    result === null ||
    typeof result !== "object" ||
    typeof (result as { text?: unknown }).text !== "string" ||
    (result as { text: string }).text.trim().length === 0 ||
    ((result as { source?: unknown }).source !== "custom" &&
      (result as { source?: unknown }).source !== "default")
  ) {
    throw new Error(
      "onTurn returned an invalid TurnResult (expected a non-empty { text, source } " +
        "where source is \"custom\" or \"default\"). Nothing was persisted.",
    );
  }
}

/** Inputs to persist the user+agent pair for one turn. */
export interface PersistTurnPairInput {
  readonly roomId: string;
  readonly userText: string;
  readonly agentText: string;
}

/**
 * Persist the user+agent PAIR for one turn, in that order (user THEN agent), so the
 * stored createdAt ordering matches M1 (where respond() saved the user turn before the
 * agent reply). Called by the rail exactly ONCE per turn, AFTER a successful reply.
 */
export async function persistTurnPair(
  runtime: IAgentRuntime,
  input: PersistTurnPairInput,
): Promise<void> {
  await saveTurn(runtime, { roomId: input.roomId, role: "user", text: input.userText });
  await saveTurn(runtime, { roomId: input.roomId, role: "agent", text: input.agentText });
}
