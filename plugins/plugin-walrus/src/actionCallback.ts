// actionCallback.ts — shared callback/return plumbing for the Walrus actions.
//
// The HandlerCallback is the PRIMARY action surface (PHASE1_PLAN gate item 5):
// consumers and the Task-6b test assert on the emitted Content.data, NOT on the
// handler's return value. The returned ActionResult is secondary (a boolean-ish
// success signal for action chaining) and mirrors the same payload.

import type { ActionResult, Content, HandlerCallback } from "@elizaos/core";
import type { WalrusActionCallback } from "./types.js";

// The walrus.error union member, as a factory so the actions don't repeat the
// literal. Returns the Extract subtype so callers can read `.message` directly.
export function walrusError(
  operation: "store" | "read",
  errorName: string,
  message: string,
  retryable: boolean,
): Extract<WalrusActionCallback, { type: "walrus.error" }> {
  return { type: "walrus.error", operation, errorName, message, retryable };
}

function emitWalrusCallback(
  callback: HandlerCallback | undefined,
  text: string,
  data: WalrusActionCallback,
): Promise<unknown> {
  if (callback === undefined) return Promise.resolve(undefined);
  const content: Content = { text, data };
  return callback(content);
}

function toActionResult(
  ok: boolean,
  text: string,
  data: WalrusActionCallback,
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
// action's output surface for Phase 1, and Handler returns ActionResult | void,
// not those memories. Revisit in Task 6b if a runtime convention needs them
// propagated.
export async function settle(
  callback: HandlerCallback | undefined,
  ok: boolean,
  text: string,
  data: WalrusActionCallback,
): Promise<ActionResult> {
  await emitWalrusCallback(callback, text, data);
  return toActionResult(ok, text, data);
}
