// actionInput.ts — structured input resolution for the MemWal actions (A1, Task 4).
//
// A1 actions are invoked PROGRAMMATICALLY: their input is a structured record on
// the action `options`, NOT free-text parsed from a message (the conversational /
// lifecycle trigger is A3, not here). This mirrors plugin-walrus's actionInput.ts
// shape (a `resolve*` returning a discriminated `{ ok }` so the handler never
// throws on bad input) but reads from `options` instead of message text.
//
// The Checkpoint field guard here DUPLICATES the field checks the service's private
// `isCheckpoint` enforces (roomId/summary/user/agent/session strings +
// createdAt/turnCount numbers). The service keeps its copy private and is NOT
// modified by this task; this standalone guard is the action's fail-fast convenience
// (the service stays the authoritative validator on read-back).

import type { Checkpoint } from "./types.js";

// Structural validation of a candidate Checkpoint. Same field set the service's
// private isCheckpoint enforces — kept in lockstep with the Checkpoint type.
export function isCheckpoint(value: unknown): value is Checkpoint {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.roomId === "string" &&
    typeof o.summary === "string" &&
    typeof o.user === "string" &&
    typeof o.agent === "string" &&
    typeof o.session === "string" &&
    typeof o.createdAt === "number" &&
    typeof o.turnCount === "number"
  );
}

// Resolved write input: a well-formed Checkpoint, or a typed error the handler maps
// to a memwal.error callback (NEVER a throw).
export type ResolvedCheckpoint =
  | { ok: true; checkpoint: Checkpoint }
  | { ok: false; errorName: string; message: string };

// Pull the structured Checkpoint off the action `options` (the programmatic input).
// Accepts either `options.checkpoint` (the canonical field) or `options` itself
// being a Checkpoint, so a caller can pass the record directly. Invalid -> typed
// error, never a throw.
export function resolveCheckpoint(options: unknown): ResolvedCheckpoint {
  const candidate =
    options !== null && typeof options === "object" && "checkpoint" in options
      ? (options as { checkpoint: unknown }).checkpoint
      : options;
  if (!isCheckpoint(candidate)) {
    return {
      ok: false,
      errorName: "InvalidCheckpointInput",
      message:
        "write action requires a well-formed Checkpoint in options " +
        "(roomId/summary/user/agent/session strings + createdAt/turnCount numbers).",
    };
  }
  return { ok: true, checkpoint: candidate };
}

// Resolved read input: a non-empty blobId string, or a typed error.
export type ResolvedBlobId =
  | { ok: true; blobId: string }
  | { ok: false; errorName: string; message: string };

// Pull the blobId off the action `options`. Accepts `options.blobId` (canonical) or
// `options` being the blobId string directly. Empty / non-string -> typed error.
export function resolveBlobId(options: unknown): ResolvedBlobId {
  const candidate =
    options !== null && typeof options === "object" && "blobId" in options
      ? (options as { blobId: unknown }).blobId
      : options;
  if (typeof candidate !== "string" || candidate.length === 0) {
    return {
      ok: false,
      errorName: "InvalidBlobIdInput",
      message: "read action requires a non-empty blobId string in options.",
    };
  }
  return { ok: true, blobId: candidate };
}
