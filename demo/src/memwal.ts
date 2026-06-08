// MemWal checkpoint layer for the demo: condense a chat session into a summary
// and store it as a PLAIN blob on Walrus (no Seal in the demo -- locked in
// GOAL.md). On a new session the summary is read back so the agent can continue
// with prior context.
//
// MemWal composes Walrus (the dependency direction in PLAN.md): this module calls
// the Walrus HTTP client and the runtime's LLM; nothing in walrusHttp depends on
// this. The blob is JSON: { roomId, createdAt, turnCount, summary }.

import { ModelType } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import { listTurns } from "./chatMemory.js";
import { storeBlob, readBlob, type WalrusHttpConfig } from "./walrusHttp.js";
import { recordCheckpoint } from "./state.js";

const GROQ_ERROR_SENTINEL = "Error generating text. Please try again later.";
const PREVIEW_CHARS = 100;

/** The condensed session record stored on Walrus and recalled on resume. */
export interface Checkpoint {
  readonly roomId: string;
  readonly createdAt: number;
  readonly turnCount: number;
  readonly summary: string;
}

function previewOf(summary: string): string {
  const flat = summary.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}...` : flat;
}

function buildSummaryPrompt(transcript: string): string {
  return [
    "Summarize the following assistant/user conversation into a concise checkpoint",
    "that a future session can resume from. Capture: what the user wanted, any key",
    "facts they gave, and -- if a job was being set up -- which job it was and which",
    "parameters have been collected so far versus still missing.",
    "Write 2-4 plain sentences. No preamble, no markdown, no bullet symbols.",
    "",
    "Conversation:",
    transcript,
    "",
    "Checkpoint summary:",
  ].join("\n");
}

/**
 * Condense the current room's chat into a summary and store it on Walrus. Records
 * the checkpoint pointer in demo state. Returns the blobId and a short preview.
 * Throws a friendly Error if the room has no turns yet; propagates WalrusHttpError
 * on storage failure (no local fallback).
 */
export async function writeCheckpoint(
  runtime: IAgentRuntime,
  walrusCfg: WalrusHttpConfig,
  roomId: string,
): Promise<{ blobId: string; preview: string }> {
  const turns = await listTurns(runtime, roomId);
  if (turns.length === 0) {
    throw new Error("Nothing to checkpoint yet -- say something to the agent first.");
  }

  const transcript = turns
    .map((turn) => `${turn.role === "agent" ? "Agent" : "User"}: ${turn.text}`)
    .join("\n");

  const raw = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: buildSummaryPrompt(transcript),
  });
  const summary = (typeof raw === "string" ? raw : String(raw ?? "")).trim();
  if (summary.length === 0 || summary === GROQ_ERROR_SENTINEL) {
    throw new Error("Failed to summarize the session for the checkpoint (LLM error).");
  }

  const checkpoint: Checkpoint = {
    roomId,
    createdAt: Date.now(),
    turnCount: turns.length,
    summary,
  };

  const bytes = new TextEncoder().encode(JSON.stringify(checkpoint));
  const { blobId } = await storeBlob(walrusCfg, bytes);

  const preview = previewOf(summary);
  await recordCheckpoint({ blobId, roomId, createdAt: checkpoint.createdAt, preview });

  return { blobId, preview };
}

/**
 * Read a checkpoint blob back from Walrus and parse it. Propagates
 * WalrusHttpError on read failure; throws a clear Error if the blob is malformed.
 */
export async function readCheckpoint(
  walrusCfg: WalrusHttpConfig,
  blobId: string,
): Promise<Checkpoint> {
  const bytes = await readBlob(walrusCfg, blobId);
  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Checkpoint blob ${blobId} was not valid JSON: ${String(cause)}`);
  }
  const obj = parsed as Partial<Checkpoint>;
  if (typeof obj.summary !== "string" || typeof obj.roomId !== "string") {
    throw new Error(`Checkpoint blob ${blobId} is missing required fields.`);
  }
  return {
    roomId: obj.roomId,
    createdAt: typeof obj.createdAt === "number" ? obj.createdAt : 0,
    turnCount: typeof obj.turnCount === "number" ? obj.turnCount : 0,
    summary: obj.summary,
  };
}
