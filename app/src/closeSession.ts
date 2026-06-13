// closeSession.ts — the checkpoint WRITE side: condense a chat session into a
// seven-field Checkpoint and write it through the real MemwalService. A
// session-lifecycle hook, NOT a per-message evaluator (per-message would store a
// gas-costing blob per turn); the caller triggers it on session-leave / a length gate.

import { ModelType } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";

import { listTurns, type ChatTurn } from "./chatMemory.js";
import type {
  Checkpoint,
  WriteCheckpointResult,
} from "../../plugins/plugin-memwal/src/types.js";

// plugin-groq returns this sentinel instead of throwing; treat it as a hard summarize
// failure so we never store a fake summary.
const GROQ_ERROR_SENTINEL = "Error generating text. Please try again later.";

// Chars of the summary surfaced in the success outcome (a preview, not the blob).
const PREVIEW_CHARS = 100;

// The MemWal surface, resolved structurally from getService("memwal") — app
// depends on the runtime contract, not the plugin class (contract TYPES imported).
type MemwalWriter = {
  writeCheckpoint(cp: Checkpoint): Promise<WriteCheckpointResult>;
};

// Terminal outcomes the caller acts on distinctly: empty (no-op, no write), saved
// (durable + indexed), degraded (durable but indexed:false -> recall may miss), and
// a typed error (ok:false; config_error is the signer-less/unfunded case).
export type CloseOutcome =
  | { kind: "empty"; message: string }
  | { kind: "saved"; blobId: string; preview: string; message: string }
  | { kind: "degraded"; blobId: string; preview: string; message: string }
  | {
      kind: "error";
      errorKind: "config_error" | "network_error";
      errorName: string;
      message: string;
      retryable: boolean;
    };

export interface CloseSessionInput {
  readonly roomId: string;
  readonly user: string;
  readonly agent: string;
  readonly session: string;
  /** OPTIONAL summarize seam: prompt -> summary text (e.g. an agent's provider
   *  chain). Absent -> the runtime's configured model via useModel(TEXT_LARGE). */
  readonly summarize?: (prompt: string) => Promise<string>;
}

// --- Pure helpers (no runtime, no I/O — unit-testable without a key/wallet) ---

function previewOf(summary: string): string {
  const flat = summary.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}...` : flat;
}

/**
 * The summarize prompt. LIFTED verbatim from demo/src/memwal.ts buildSummaryPrompt
 * so the condensation behavior matches the proven demo. Exported so the proof can
 * inspect it deterministically.
 */
export function buildSummaryPrompt(transcript: string): string {
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
 * Flatten a turn list into the demo's `Agent:`/`User:` transcript (oldest-first).
 * LIFTED from demo/src/memwal.ts writeCheckpoint. Pure: same turns -> same string.
 */
export function flattenTranscript(turns: readonly ChatTurn[]): string {
  return turns
    .map((turn) => `${turn.role === "agent" ? "Agent" : "User"}: ${turn.text}`)
    .join("\n");
}

/**
 * Map a WriteCheckpointResult onto a CloseOutcome (pure, unit-testable). Only an
 * explicit indexed===true is "saved"; ok:true with missing/false indexed is degraded
 * (durable but recall-by-index may miss); ok:false is a typed error.
 */
export function mapWriteOutcome(
  result: WriteCheckpointResult,
  summary: string,
): CloseOutcome {
  if (result.ok) {
    const preview = previewOf(summary);
    if (result.indexed === true) {
      return {
        kind: "saved",
        blobId: result.blobId,
        preview,
        message: `Checkpoint saved: blob ${result.blobId} is durable on Walrus and indexed for recall.`,
      };
    }
    // ok:true but the index entry did NOT land: blob durable, recall-by-index at risk.
    return {
      kind: "degraded",
      blobId: result.blobId,
      preview,
      message:
        `DEGRADED: checkpoint blob ${result.blobId} is durable on Walrus, but its ` +
        `(user, agent)-index entry did NOT land — recall-by-index may miss it.`,
    };
  }
  // ok:false -> typed failure. NEVER report success. config_error is the no-funded-
  // signer case; network_error is retryable.
  return {
    kind: "error",
    errorKind: result.kind,
    errorName: result.errorName,
    message: result.message,
    retryable: result.retryable,
  };
}

/**
 * Length-limit gate (pure): should a session of `turnCount` turns be checkpointed?
 * A non-positive/non-finite limit disables the trigger (returns false).
 */
export function shouldCheckpointForLength(turnCount: number, limit: number): boolean {
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return turnCount >= limit;
}

// Resolve the live MemwalService structurally; undefined if absent (caller maps to a
// typed config outcome, not a throw).
function resolveMemwal(runtime: IAgentRuntime): MemwalWriter | undefined {
  const resolved = runtime.getService("memwal");
  if (resolved === undefined || resolved === null) return undefined;
  return resolved as unknown as MemwalWriter;
}

/**
 * Close a session: read the transcript, summarize it into a Checkpoint, and write it
 * through MemwalService. Returns a CloseOutcome (never throws for the write outcomes
 * or an empty session; only rejects if the summarize step itself fails).
 */
export async function closeSession(
  runtime: IAgentRuntime,
  input: CloseSessionInput,
): Promise<CloseOutcome> {
  const turns = await listTurns(runtime, input.roomId);

  // Empty session -> write nothing, clean no-op.
  if (turns.length === 0) {
    return {
      kind: "empty",
      message:
        `Nothing to checkpoint: room ${input.roomId} has no turns. ` +
        "No blob was written.",
    };
  }

  // 2. Flatten + LLM-summarize: through the injected summarize seam when present
  //    (an agent's provider chain), else the runtime's configured model.
  const transcript = flattenTranscript(turns);
  const prompt = buildSummaryPrompt(transcript);
  const raw =
    input.summarize !== undefined
      ? await input.summarize(prompt)
      : await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  const summary = (typeof raw === "string" ? raw : String(raw ?? "")).trim();

  // Empty/sentinel summary = precondition failure (no Checkpoint to write) -> throw.
  // Kept for BOTH paths as defense in depth.
  if (summary.length === 0 || summary === GROQ_ERROR_SENTINEL) {
    throw new Error(
      "Failed to summarize the session for the checkpoint (LLM error). Check the model provider key/config.",
    );
  }

  // 3. Assemble the FULL seven-field Checkpoint: the demo's four fields plus the
  //    (user, agent, session) index-key triple the MemWal index resolves on.
  const checkpoint: Checkpoint = {
    roomId: input.roomId,
    createdAt: Date.now(),
    turnCount: turns.length,
    summary,
    user: input.user,
    agent: input.agent,
    session: input.session,
  };

  // 4. Write through the REAL service. If the service is not registered, surface a
  //    typed config-style error (do NOT throw, do NOT claim success) — mirrors the
  //    service's own "walrus not registered" config_error shape.
  const memwal = resolveMemwal(runtime);
  if (memwal === undefined) {
    return {
      kind: "error",
      errorKind: "config_error",
      errorName: "MemwalServiceUnavailable",
      message: "memwal service is not registered",
      retryable: false,
    };
  }

  const result = await memwal.writeCheckpoint(checkpoint);

  // 5. Map the typed result onto a DISTINCT, correctly-labeled outcome.
  return mapWriteOutcome(result, summary);
}
