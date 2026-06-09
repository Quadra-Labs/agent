// closeSession.ts — A3 Task 4: the checkpoint WRITE/close side.
//
// A session-lifecycle hook that condenses a chat session into a full seven-field
// Checkpoint and writes it through the REAL MemwalService. This is the HEART of A3:
// the write-on-close path. It is the WRITE side ONLY — reading a prior checkpoint
// back into a NEW session is Task 5 and is deliberately NOT built here.
//
// WHY A HOOK, NOT A PER-MESSAGE EVALUATOR (load-bearing design choice):
//   ElizaOS evaluators run AFTER EVERY message. Checkpointing on every message
//   would condense + store a blob on Walrus per turn — each store costs gas (the
//   A3 SDK path uses a funded signer). That burns money and produces dozens of
//   near-duplicate checkpoints per session. So the trigger is a SESSION-LIFECYCLE
//   decision instead: (a) explicit session-leave (closeSession), and (b) a
//   length-limit gate (shouldCheckpointForLength) the caller consults to roll the
//   session over once it grows past a configured turn count. plugin-memwal's
//   index.ts already documents "NO evaluators ... the write-on-close lifecycle is
//   A3"; this file is that lifecycle, and it registers NO evaluator.
//
// WHAT IT COMPOSES (never the reverse): it calls the runtime's LLM (useModel) and
// the resolved MemwalService.writeCheckpoint. MemwalService composes Walrus
// underneath. This module never re-implements Walrus or summarization-into-storage
// — it calls the plugin. The summarize step lives HERE (Task 4) because A1's
// writeCheckpoint takes an ALREADY-built Checkpoint.

import { ModelType } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";

import { listTurns, type ChatTurn } from "./chatMemory.js";
import type {
  Checkpoint,
  WriteCheckpointResult,
} from "../../../plugins/plugin-memwal/src/types.js";

// plugin-groq swallows API errors and returns this sentinel string instead of
// throwing. Lifted from demo/src/memwal.ts (and chat.ts): treat it as a hard
// summarize failure so we never store a fake "summary". The error text mirrors the
// demo's guard exactly.
const GROQ_ERROR_SENTINEL = "Error generating text. Please try again later.";

// Chars of the summary surfaced in the success outcome (a human-readable preview,
// not the whole blob). Lifted from demo/src/memwal.ts previewOf.
const PREVIEW_CHARS = 100;

// --- The MemWal surface this module drives (structural mirror) ---------------
// Resolved from the booted runtime via getService("memwal"); narrowed to exactly
// the one method we call. Mirrors roundtrip.ts's MemwalLike — apps/agent depends on
// the runtime CONTRACT, not on plugin-memwal's internal class. The locked contract
// TYPES (Checkpoint / WriteCheckpointResult) are imported from the plugin's
// types.ts (the same source roundtrip.ts uses); only the service CLASS is resolved
// structurally.
type MemwalWriter = {
  writeCheckpoint(cp: Checkpoint): Promise<WriteCheckpointResult>;
};

// --- Outcome of a closeSession call ------------------------------------------
// Three terminal outcomes the CALLER can see and act on distinctly. This is the
// HARD A3 requirement: ok:true+indexed:true (saved), ok:true+indexed:false
// (DEGRADED — blob durable but recall-by-index may miss it), and ok:false (typed
// error). Plus the empty-session no-op, which writes NOTHING.
export type CloseOutcome =
  // Nothing to checkpoint: the session had zero turns. NO MemWal call was made, NO
  // error was thrown. The caller should treat this as a clean no-op.
  | { kind: "empty"; message: string }
  // Full success: blob durable on Walrus AND the (user, agent)-index entry landed,
  // so recall-by-index will find it.
  | { kind: "saved"; blobId: string; preview: string; message: string }
  // DEGRADED success: blob IS durable on Walrus, but the (user, agent)-index entry
  // did NOT land (indexed:false). Recall-by-index may MISS this blob. This is NOT a
  // plain "memory saved" — the caller must be able to tell it apart from "saved".
  | { kind: "degraded"; blobId: string; preview: string; message: string }
  // Typed failure: the write returned ok:false (config_error / network_error). The
  // blob is NOT durable. Carries the typed kind + message so the caller surfaces
  // the real error and does NOT claim success. config_error is what a signer-less /
  // unfunded Walrus returns.
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
 * Map a typed WriteCheckpointResult onto a CloseOutcome. THIS is the
 * outcome-mapping function the A3 requirement calls out: it makes the three write
 * outcomes DISTINCT and correctly-labeled. Pure and synchronous so it can be
 * unit-tested in ISOLATION by feeding synthetic results — no funded wallet needed:
 *   - ok:true, indexed:true  -> { kind: "saved" }
 *   - ok:true, indexed:false -> { kind: "degraded" }   (DISTINCT from saved)
 *   - ok:false               -> { kind: "error", ... } (typed; never "saved")
 *
 * The `indexed` field is OPTIONAL on the contract; a MISSING `indexed` is treated
 * as NOT indexed (degraded), since we cannot prove the index entry landed. Only an
 * explicit `indexed === true` counts as fully saved.
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
    // ok:true but the index entry did NOT land (false or undefined). The blob IS
    // durable; only recall-by-index is at risk. DEGRADED, not "saved".
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
 * Length-limit decision: should a session of `turnCount` turns be checkpointed?
 * Pure — the SESSION-LIFECYCLE gate the caller consults (NOT a per-message
 * evaluator). True at/over the limit, false below it. A non-positive or
 * non-finite limit disables the length trigger (returns false) so a misconfigured
 * limit never forces a checkpoint on every turn. Unit-testable with no key/wallet.
 */
export function shouldCheckpointForLength(turnCount: number, limit: number): boolean {
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return turnCount >= limit;
}

// --- The lifecycle hook ------------------------------------------------------

// Resolve the live MemwalService from the booted runtime and narrow to the one
// method we call. Returns undefined if absent (the caller maps that to a typed
// config-style outcome rather than throwing). Mirrors roundtrip.ts.
function resolveMemwal(runtime: IAgentRuntime): MemwalWriter | undefined {
  const resolved = runtime.getService("memwal");
  if (resolved === undefined || resolved === null) return undefined;
  return resolved as unknown as MemwalWriter;
}

/**
 * Close a session: read the room transcript, condense it via the LLM into a
 * seven-field Checkpoint, and write it through the REAL MemwalService. Returns a
 * CloseOutcome the caller can branch on — it NEVER throws for the three write
 * outcomes or the empty session; it only rejects if the LLM summarize step itself
 * fails (no usable summary / groq sentinel), which is a genuine precondition error.
 *
 * Trigger (a): call this on explicit session-leave.
 * Trigger (b): call this when shouldCheckpointForLength(...) returns true (the
 *              session-length-limit gate).
 *
 * Does NOT register an evaluator (gas). Does NOT read prior checkpoints (Task 5).
 */
export async function closeSession(
  runtime: IAgentRuntime,
  input: CloseSessionInput,
): Promise<CloseOutcome> {
  // 1. Read the room transcript (Task 3's listTurns, oldest-first).
  const turns = await listTurns(runtime, input.roomId);

  // Empty-session guard (lifted from demo's writeCheckpoint): NO turns -> write
  // NOTHING. No MemWal call, no error thrown — a clean no-op outcome.
  if (turns.length === 0) {
    return {
      kind: "empty",
      message:
        `Nothing to checkpoint: room ${input.roomId} has no turns. ` +
        "No blob was written.",
    };
  }

  // 2. Flatten + LLM-summarize. The model call goes through useModel(TEXT_LARGE)
  //    — the runtime's configured Groq model, same as chat.ts and the demo. We add
  //    NO new model client and stay Anthropic-agnostic.
  const transcript = flattenTranscript(turns);
  const raw = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: buildSummaryPrompt(transcript),
  });
  const summary = (typeof raw === "string" ? raw : String(raw ?? "")).trim();

  // groq error-sentinel guard (lifted from the demo): a missing/sentinel summary is
  // a genuine precondition failure — surfacing it as a throw is correct because we
  // have no Checkpoint to write. This is distinct from the THREE write outcomes.
  if (summary.length === 0 || summary === GROQ_ERROR_SENTINEL) {
    throw new Error(
      "Failed to summarize the session for the checkpoint (LLM error). Check the Groq key/model.",
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
