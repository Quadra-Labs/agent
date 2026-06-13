// Shared callback/return plumbing for the Walrus actions. The HandlerCallback is
// the PRIMARY action surface (consumers assert on the emitted Content.data); the
// returned ActionResult is secondary and mirrors the same payload.

import type { ActionResult, Content, HandlerCallback } from "@elizaos/core";
import type { WalrusActionCallback } from "./types.js";

// Factory for the walrus.error union member; the Extract subtype lets callers read `.message`.
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

// Emit the callback AND build the matching return value in one step. The Memory[]
// the HandlerCallback resolves to is intentionally ignored: the emitted Content is
// the output surface, and Handler returns ActionResult | void.
export async function settle(
  callback: HandlerCallback | undefined,
  ok: boolean,
  text: string,
  data: WalrusActionCallback,
): Promise<ActionResult> {
  await emitWalrusCallback(callback, text, data);
  return toActionResult(ok, text, data);
}
