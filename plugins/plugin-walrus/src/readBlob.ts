// readBlob.ts — WALRUS_READ_BLOB action (Phase 1, Task 3).
//
// A THIN delegate: resolve the long-lived WalrusService via runtime.getService
// (the SAME instance as storeBlob), resolve the blobId, call service.read, and
// map the typed WalrusReadResult DIRECTLY onto the locked callback union.
//
// This is a RETRIEVABILITY / DIGEST action: on success it reports blobId,
// sizeBytes, and sha256 — NOT the inline bytes. Raw bytes stay at the service
// layer (read() returns them) for Phase-3 programmatic consumers. A missing /
// non-certified blob surfaces as the typed `walrus.read.unavailable` VALUE,
// never a throw and never null.

import type { Action } from "@elizaos/core";

import { WalrusService } from "./walrusService.js";
import { resolveReadBlobId } from "./actionInput.js";
import { sha256Hex } from "./sha256.js";
import { settle, walrusError } from "./actionCallback.js";
import type { WalrusActionCallback } from "./types.js";

export const WALRUS_READ_BLOB = "WALRUS_READ_BLOB";

export const readBlobAction: Action = {
  name: WALRUS_READ_BLOB,
  similes: ["READ_BLOB", "WALRUS_READ", "WALRUS_GET_BLOB", "FETCH_BLOB"],
  description:
    "Read a blob from Walrus by blobId and report its retrievability and digest (blobId, sizeBytes, sha256). Does not inline the bytes.",
  // Applicable only when the message yields a blobId (an explicit field, or text
  // shaped like a blob id) — so the action is not eligible for arbitrary chat.
  // `validate` only sees runtime/message/state (no options), mirroring the
  // handler's message-only input path; direct/options invocation bypasses it.
  validate: async (_runtime, message) => resolveReadBlobId(message).ok,
  handler: async (runtime, message, _state, options, callback) => {
    const service = runtime.getService<WalrusService>(WalrusService.serviceType);
    if (service === null || service === undefined) {
      const payload = walrusError(
        "read",
        "WalrusServiceUnavailable",
        "walrus service is not registered",
        false,
      );
      return settle(callback, false, payload.message, payload);
    }

    const input = resolveReadBlobId(message, options);
    if (!input.ok) {
      const payload = walrusError("read", input.errorName, input.message, false);
      return settle(callback, false, payload.message, payload);
    }

    const result = await service.read(input.blobId);
    if (result.ok) {
      const payload: WalrusActionCallback = {
        type: "walrus.read.success",
        blobId: result.blobId,
        sizeBytes: result.bytes.length,
        sha256: sha256Hex(result.bytes),
      };
      const text = `Read blob ${result.blobId} from Walrus (${result.bytes.length} bytes).`;
      return settle(callback, true, text, payload);
    }

    if (result.kind === "blob_unavailable") {
      const payload: WalrusActionCallback = {
        type: "walrus.read.unavailable",
        blobId: result.blobId,
        errorName: result.errorName,
        message: result.message,
      };
      return settle(callback, false, payload.message, payload);
    }

    // network_error | config_error -> walrus.error (map message DIRECTLY).
    const payload = walrusError("read", result.errorName, result.message, result.retryable);
    return settle(callback, false, payload.message, payload);
  },
};

export default readBlobAction;
