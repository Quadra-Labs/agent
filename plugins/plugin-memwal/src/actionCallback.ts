// actionCallback.ts — shared callback/return plumbing for the MemWal actions (A1, Task 4).
//
// Mirrors plugin-walrus/src/actionCallback.ts. The HandlerCallback is the PRIMARY
// action surface: consumers and the end-to-end action test assert on the emitted
// Content.data (the MemwalActionCallback), NOT on the handler's return value. The
// returned ActionResult is secondary (a boolean-ish success signal for action
// chaining) and mirrors the same payload.
//
// The MemwalActionCallback discriminated union lives HERE (a new file), separate
// from the locked service result unions in types.ts (WriteCheckpointResult /
// ReadCheckpointResult / Checkpoint) — those stay untouched. Walrus keeps its
// WalrusActionCallback in types.ts; for MemWal a dedicated file is cleaner and
// avoids editing the locked contract file.

import type { ActionResult, Content, HandlerCallback } from "@elizaos/core";
import type { Checkpoint } from "./types.js";

// The discriminated payload the A1 actions place on a Content's `data` field, e.g.
// callback({ text, data: <MemwalActionCallback> }). `type` is the discriminator
// (NOT errorName, which is a free-form label). On write success it carries the
// blobId and the `indexed` signal (whether the recall index entry landed); on read
// success it carries the parsed Checkpoint (the full record — recall reproduces it
// end to end). Both write and read failures collapse to a single `memwal.error`
// member discriminated further by `operation`.
export type MemwalActionCallback =
  | { type: "memwal.write.success"; blobId: string; indexed: boolean }
  | { type: "memwal.read.success"; checkpoint: Checkpoint }
  | { type: "memwal.error"; operation: "write" | "read"; errorName: string; message: string; retryable: boolean };

// The memwal.error union member, as a factory so the actions don't repeat the
// literal. Returns the Extract subtype so callers can read `.message` directly.
export function memwalError(
  operation: "write" | "read",
  errorName: string,
  message: string,
  retryable: boolean,
): Extract<MemwalActionCallback, { type: "memwal.error" }> {
  return { type: "memwal.error", operation, errorName, message, retryable };
}

function emitMemwalCallback(
  callback: HandlerCallback | undefined,
  text: string,
  data: MemwalActionCallback,
): Promise<unknown> {
  if (callback === undefined) return Promise.resolve(undefined);
  const content: Content = { text, data };
  return callback(content);
}

function toActionResult(
  ok: boolean,
  text: string,
  data: MemwalActionCallback,
): ActionResult {
  return ok
    ? { success: true, text, data: { ...data } }
    : { success: false, text, error: text, data: { ...data } };
}

// Emit the callback AND build the matching return value in one step, so each
// action branch is a single thin line. `ok` drives the ActionResult.success flag.
//
// We intentionally ignore the Memory[] that the HandlerCallback resolves to: the
// callback's side effect (emitting Content the consumer/test asserts on) is the
// action's output surface, and Handler returns ActionResult | void, not those
// memories — same reasoning as plugin-walrus's settle.
export async function settle(
  callback: HandlerCallback | undefined,
  ok: boolean,
  text: string,
  data: MemwalActionCallback,
): Promise<ActionResult> {
  await emitMemwalCallback(callback, text, data);
  return toActionResult(ok, text, data);
}
