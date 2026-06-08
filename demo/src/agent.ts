// The agent's single conversational turn. Mirrors the proven flattened-prompt
// approach from phase0 / the foundation smoke: build ONE string prompt and call
// runtime.useModel(ModelType.TEXT_LARGE, { prompt }). plugin-groq is configured
// for string prompts (memory: elizaos-standalone), so we do not pass a messages
// array.
//
// Flow: persist the user turn -> assemble [system prompt + recent history +
// "Agent:" cue] -> call the LLM -> persist and return the agent turn. History is
// read from the LOCAL DB (chatMemory) so it reflects exactly what was stored.

import { ModelType } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import { saveTurn, listTurns, type ChatTurn } from "./chatMemory.js";
import { buildSystemPrompt } from "./character.js";

// plugin-groq swallows API errors and returns this sentinel instead of throwing.
// Treat it as a hard failure so the REPL/smoke surface the real problem.
const GROQ_ERROR_SENTINEL = "Error generating text. Please try again later.";

// Cap the history window injected into the prompt. Recent context is enough for
// the demo and keeps the prompt bounded as a session grows.
const MAX_HISTORY_TURNS = 30;

export interface RespondInput {
  readonly roomId: string;
  readonly userText: string;
  /** Readable job descriptions for the system prompt (never shown to the user). */
  readonly templatesText: string;
  /** Recalled checkpoint summary when continuing a resumed session. */
  readonly resumedSummary?: string;
}

function labelFor(role: ChatTurn["role"]): string {
  return role === "agent" ? "Agent" : "User";
}

function renderHistory(turns: readonly ChatTurn[]): string {
  const recent = turns.slice(-MAX_HISTORY_TURNS);
  return recent.map((turn) => `${labelFor(turn.role)}: ${turn.text}`).join("\n");
}

/**
 * Run one agent turn. Saves the user message, queries the LLM with the full
 * flattened prompt, saves and returns the agent reply (trimmed). Throws if the
 * model yields empty text or the plugin-groq error sentinel.
 */
export async function respond(
  runtime: IAgentRuntime,
  input: RespondInput,
): Promise<string> {
  await saveTurn(runtime, { roomId: input.roomId, role: "user", text: input.userText });

  const history = await listTurns(runtime, input.roomId);
  const systemPrompt = buildSystemPrompt({
    templatesText: input.templatesText,
    resumedSummary: input.resumedSummary,
  });

  const prompt = [
    systemPrompt,
    "",
    "Conversation so far:",
    renderHistory(history),
    "",
    "Agent:",
  ].join("\n");

  const raw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const text = (typeof raw === "string" ? raw : String(raw ?? "")).trim();

  if (text.length === 0 || text === GROQ_ERROR_SENTINEL) {
    const why = text === GROQ_ERROR_SENTINEL ? "groq error sentinel" : "empty response";
    throw new Error(`Agent produced no usable reply (${why}). Check the Groq key/model.`);
  }

  await saveTurn(runtime, { roomId: input.roomId, role: "agent", text });
  return text;
}
