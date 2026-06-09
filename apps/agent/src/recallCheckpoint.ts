// recallCheckpoint.ts — A3 Task 5: the checkpoint READ/recall side.
//
// At the START of a NEW (user, agent) session, resolve the prior checkpoint via
// MemWal's index, read it back, and surface its summary so the new session can be
// resumed from prior context. This is the READ half of cross-session memory; Task 4
// (closeSession) is the WRITE half. This file does NOT write checkpoints, does NOT
// run the model, and does NOT string write+recall together into the end-to-end gate
// (that is Task 6) — it only RESOLVES + READS + EXTRACTS, returning a typed outcome.
//
// IDENTITY MATCH (load-bearing): recall resolves the index on (user, agent[,
// session]) via MemwalService.latest. The WRITER (closeSession) records the index
// under (checkpoint.user, checkpoint.agent, checkpoint.session). So the (user,
// agent) strings passed HERE must be the SAME strings the caller passed to
// closeSession for the namespace to resolve. Mismatch -> latest() returns undefined
// -> recall always reports "no prior checkpoint" and the exit gate silently breaks.
// The caller owns supplying matching identities; this module passes them through
// UNCHANGED to latest().
//
// DEGRADED-WRITE CONSEQUENCE (surfaced here): a prior write that returned
// indexed:false (Task 4 "degraded") left the blob durable on Walrus but recorded NO
// index entry. The index therefore has no mapping, so latest() returns undefined and
// recall reports "none" (no prior checkpoint) — exactly the read-side consequence of
// a degraded write. This is a clean fresh start, NOT an error.
//
// MemWal composes Walrus (dependency direction apps/agent -> MemWal -> Walrus, never
// the reverse). This module resolves the live MemwalService structurally (the
// runtime CONTRACT, not the plugin class) and calls only latest + readCheckpoint.

import type { IAgentRuntime } from "@elizaos/core";

import type {
  Checkpoint,
  ReadCheckpointResult,
} from "../../../plugins/plugin-memwal/src/types.js";

// --- The MemWal surface this module READS through (structural mirror) ---------
// Resolved from the booted runtime via getService("memwal"); narrowed to exactly
// the two read methods we call. Mirrors closeSession.ts's MemwalWriter and
// roundtrip.ts's MemwalLike — apps/agent depends on the runtime CONTRACT, not on
// plugin-memwal's internal class. The locked contract TYPE (ReadCheckpointResult)
// is imported from the plugin's types.ts (the same source the writer uses); only
// the service CLASS is resolved structurally. A tiny fake satisfying this shape is
// all the synthetic resolve-mapping proof needs (no wallet, no live Walrus).
export type MemwalReader = {
  latest(user: string, agent: string, session?: string): Promise<string | undefined>;
  readCheckpoint(blobId: string): Promise<ReadCheckpointResult>;
};

// --- Outcome of a recallCheckpoint call --------------------------------------
// Three terminal outcomes the CALLER branches on; recallCheckpoint NEVER throws for
// any of them — a fresh session is always startable.
//   - "none":     no index entry resolved (first run, OR a prior indexed:false
//                 degraded write). Start FRESH, no recalled summary. NOT an error.
//   - "recalled": a blob resolved and read back ok:true; `summary` is the recalled
//                 prior-session context to inject via respond({ resumedSummary }).
//   - "error":    the read returned ok:false (blob_unavailable / network_error /
//                 config_error / invalid_checkpoint). Start FRESH WITHOUT crashing;
//                 the typed `errorKind` is surfaced so the caller knows recall
//                 failed (vs. genuinely having no prior checkpoint).
export type RecallOutcome =
  | { kind: "none"; message: string }
  | { kind: "recalled"; blobId: string; summary: string; checkpoint: Checkpoint; message: string }
  | {
      kind: "error";
      errorKind: "blob_unavailable" | "network_error" | "config_error" | "invalid_checkpoint";
      errorName: string;
      blobId: string;
      message: string;
      retryable: boolean;
    };

export interface RecallInput {
  /** Index-key user — MUST match the `user` the writer (closeSession) put in the
   *  Checkpoint, or the namespace will not resolve. */
  readonly user: string;
  /** Index-key agent — MUST match the writer's `agent`. */
  readonly agent: string;
  /** OPTIONAL session narrowing. Omit to recall the newest checkpoint for the
   *  (user, agent) pair regardless of session (the cross-session resume case). */
  readonly session?: string;
}

// --- Pure mapper (no runtime, no I/O — synthetic-testable without a wallet) ----

/**
 * Map a resolved blobId + its ReadCheckpointResult onto a RecallOutcome. THIS is
 * the index->read->extract mapping the Task 5 "done" bar calls out: on ok:true it
 * EXTRACTS checkpoint.summary into a "recalled" outcome; on ok:false it carries the
 * typed failure kind through into an "error" outcome (NEVER a throw). Pure and
 * synchronous so the proof can feed synthetic ReadCheckpointResults and assert both
 * the summary extraction and that every failure kind maps through — no funded
 * wallet, no live Walrus needed.
 */
export function mapReadOutcome(
  blobId: string,
  result: ReadCheckpointResult,
): RecallOutcome {
  if (result.ok) {
    return {
      kind: "recalled",
      blobId,
      summary: result.checkpoint.summary,
      checkpoint: result.checkpoint,
      message: `Recalled checkpoint blob ${blobId}; continuing from its summary.`,
    };
  }
  // ok:false -> typed read failure. Start fresh, but surface the real failure kind
  // so the caller does NOT mistake it for a clean "no prior checkpoint".
  const blobIdOf =
    result.kind === "blob_unavailable" || result.kind === "invalid_checkpoint"
      ? result.blobId
      : blobId;
  return {
    kind: "error",
    errorKind: result.kind,
    errorName: result.errorName,
    blobId: blobIdOf,
    message: result.message,
    retryable: result.retryable,
  };
}

// The "no prior checkpoint" outcome. Factored out so both the live and synthetic
// paths return the identical clean fresh-start shape.
function noneOutcome(input: RecallInput): RecallOutcome {
  return {
    kind: "none",
    message:
      `No prior checkpoint for (user=${input.user}, agent=${input.agent}` +
      `${input.session !== undefined ? `, session=${input.session}` : ""}). ` +
      "Starting fresh. (A first run, or a prior degraded write whose index entry " +
      "did not land, both surface here as 'none'.)",
  };
}

// --- Core resolve+read, parameterized over the MemwalReader (synthetic-friendly) -

/**
 * Resolve the prior checkpoint blobId via `reader.latest(user, agent[, session])`,
 * read it back via `reader.readCheckpoint`, and map the result to a RecallOutcome.
 * Takes an EXPLICIT reader so the proof can drive a fake reader with a known
 * latest()/readCheckpoint() (the synthetic resolve-mapping branch) WITHOUT a booted
 * runtime, a wallet, or a live Walrus store. recallCheckpoint() below resolves the
 * REAL service and delegates here. Never throws for the three outcomes.
 */
export async function recallWithReader(
  reader: MemwalReader,
  input: RecallInput,
): Promise<RecallOutcome> {
  // 1. Resolve the prior blobId from the index on the SAME (user, agent[, session])
  //    the writer recorded under. undefined => no entry => clean fresh start.
  const blobId = await reader.latest(input.user, input.agent, input.session);
  if (blobId === undefined) {
    return noneOutcome(input);
  }

  // 2. Read the blob back through MemWal (which composes Walrus underneath) and map
  //    the typed result: ok:true -> extract summary; ok:false -> typed error.
  const result = await reader.readCheckpoint(blobId);
  return mapReadOutcome(blobId, result);
}

// --- The recall entry point --------------------------------------------------

// Resolve the live MemwalService from the booted runtime and narrow to the two read
// methods we call. Returns undefined if absent (mapped to a typed config-style
// outcome rather than a throw). Mirrors closeSession.ts's resolveMemwal.
function resolveMemwalReader(runtime: IAgentRuntime): MemwalReader | undefined {
  const resolved = runtime.getService("memwal");
  if (resolved === undefined || resolved === null) return undefined;
  return resolved as unknown as MemwalReader;
}

/**
 * Recall the prior checkpoint for a (user, agent[, session]) at the start of a NEW
 * session. Resolves the REAL MemwalService index, reads the prior blob back, and
 * returns a typed RecallOutcome:
 *   - "none":     no prior checkpoint (first run / degraded write) -> start fresh.
 *   - "recalled": carries `summary` to feed respond({ resumedSummary }).
 *   - "error":    typed read failure -> start fresh WITHOUT crashing; kind surfaced.
 *
 * NEVER throws for these outcomes. Does NOT write, does NOT run the model, does NOT
 * inject the summary itself — injection is the caller's choice via respond's
 * OPTIONAL resumedSummary (the Task 5 seam). The (user, agent) here MUST match what
 * the writer (closeSession) put in the Checkpoint.
 */
export async function recallCheckpoint(
  runtime: IAgentRuntime,
  input: RecallInput,
): Promise<RecallOutcome> {
  const reader = resolveMemwalReader(runtime);
  if (reader === undefined) {
    // Mirror the service's own "not registered" config_error shape; do NOT throw and
    // do NOT claim a clean "none" (the index was never even consulted).
    return {
      kind: "error",
      errorKind: "config_error",
      errorName: "MemwalServiceUnavailable",
      blobId: "",
      message: "memwal service is not registered",
      retryable: false,
    };
  }
  return recallWithReader(reader, input);
}
