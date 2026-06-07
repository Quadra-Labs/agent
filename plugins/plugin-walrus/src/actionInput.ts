// actionInput.ts — resolve an action handler's input from the ElizaOS message /
// options into the concrete value the service needs (bytes to store, blobId to
// read). Kept separate from the action files so the precedence rules are testable
// in isolation and the actions stay thin delegates.
//
// This is action-level INPUT validation, distinct from service-result mapping.
// The "never invent error text" rule (PHASE1_PLAN risks) governs how SERVICE
// results map to the callback union — there the action copies result.message
// verbatim. Pre-service input is different: there is no service result yet, so a
// missing/invalid input must be described here. The label is a fixed
// `WalrusInputError`; the message states the contract, not a fabricated SDK error.

import type { HandlerOptions, Memory } from "@elizaos/core";

export const WALRUS_INPUT_ERROR_NAME = "WalrusInputError";

export type ResolvedStoreInput =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; errorName: string; message: string };

export type ResolvedReadInput =
  | { ok: true; blobId: string }
  | { ok: false; errorName: string; message: string };

const utf8 = new TextEncoder();

function asUint8Array(value: unknown): Uint8Array | undefined {
  return value instanceof Uint8Array ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// Store input precedence: explicit bytes (options, then message.content) win;
// otherwise a non-empty string is UTF-8 encoded. Phase 1 stores OPAQUE BYTES, so
// raw bytes are the canonical input and text is a convenience for the chat path.
// NOTE: stopping an LLM from accidentally storing ordinary chat is a Phase-4
// action-SELECTION concern (the action's `validate` + description + the agent
// loop), not the resolver's job. Phase 1 has no agent loop, and a non-live store
// has no signer (-> config_error), so the text fallback is safe here.
export function resolveStoreBytes(
  message: Memory,
  options?: HandlerOptions,
): ResolvedStoreInput {
  const content = message.content;

  const fromBytes = asUint8Array(options?.["bytes"]) ?? asUint8Array(content?.["bytes"]);
  if (fromBytes !== undefined) return { ok: true, bytes: fromBytes };

  const fromText = asNonEmptyString(options?.["text"]) ?? asNonEmptyString(content?.text);
  if (fromText !== undefined) return { ok: true, bytes: utf8.encode(fromText) };

  return {
    ok: false,
    errorName: WALRUS_INPUT_ERROR_NAME,
    message: "store requires `bytes` (Uint8Array) or non-empty `text` input",
  };
}

// A Walrus blob id is base64url of a 32-byte value (~43 chars). This is a
// conservative SHAPE heuristic, NOT validation — the service/SDK stays
// authoritative. It exists only so arbitrary chat prose ("can you read my last
// file?") is never treated as a blob id in an agent loop. An explicit `blobId`
// field always wins and is never shape-checked.
const BLOB_ID_SHAPE = /^[A-Za-z0-9_-]{40,100}$/;

function looksLikeBlobId(value: string): boolean {
  return BLOB_ID_SHAPE.test(value);
}

// Read input precedence: an explicit blobId field (options, then message.content)
// wins outright. A bare message text is accepted as the blobId ONLY if it has the
// shape of one (so chat prose doesn't trigger garbage reads). Values are trimmed
// so trailing whitespace from a chat message never corrupts the id.
export function resolveReadBlobId(
  message: Memory,
  options?: HandlerOptions,
): ResolvedReadInput {
  const content = message.content;

  const explicit =
    asNonEmptyString(options?.["blobId"]) ?? asNonEmptyString(content?.["blobId"]);
  if (explicit !== undefined) return { ok: true, blobId: explicit.trim() };

  const fromText = asNonEmptyString(content?.text)?.trim();
  if (fromText !== undefined && looksLikeBlobId(fromText)) {
    return { ok: true, blobId: fromText };
  }

  return {
    ok: false,
    errorName: WALRUS_INPUT_ERROR_NAME,
    message: "read requires a `blobId` (string) input",
  };
}
