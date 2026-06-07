// storeBlob.ts — WALRUS_STORE_BLOB action (Phase 1, Task 3).
//
// A THIN delegate: resolve the long-lived WalrusService via runtime.getService
// (NEVER constructed per action), resolve the input bytes, call service.store,
// and map the typed WalrusStoreResult DIRECTLY onto the locked callback union.
// Error text is copied from result.message — actions never invent it. The
// HandlerCallback is the real output surface; the ActionResult is secondary.

import type { Action } from "@elizaos/core";

import { WalrusService } from "./walrusService.js";
import { resolveStoreBytes } from "./actionInput.js";
import { sha256Hex } from "./sha256.js";
import { settle, walrusError } from "./actionCallback.js";
import type { WalrusActionCallback } from "./types.js";

export const WALRUS_STORE_BLOB = "WALRUS_STORE_BLOB";

export const storeBlobAction: Action = {
  name: WALRUS_STORE_BLOB,
  similes: ["STORE_BLOB", "WALRUS_STORE", "WALRUS_WRITE_BLOB", "UPLOAD_BLOB"],
  description:
    "Store opaque bytes on Walrus and return the blob handle (blobId, sizeBytes, sha256).",
  // Applicable whenever the message carries storable content. `validate` only
  // sees runtime/message/state (no options), so it mirrors the handler's
  // message-only input path; programmatic/options-only invocation calls the
  // handler directly and bypasses validate.
  validate: async (_runtime, message) => resolveStoreBytes(message).ok,
  handler: async (runtime, message, _state, options, callback) => {
    const service = runtime.getService<WalrusService>(WalrusService.serviceType);
    if (service === null || service === undefined) {
      const payload = walrusError(
        "store",
        "WalrusServiceUnavailable",
        "walrus service is not registered",
        false,
      );
      return settle(callback, false, payload.message, payload);
    }

    const input = resolveStoreBytes(message, options);
    if (!input.ok) {
      const payload = walrusError("store", input.errorName, input.message, false);
      return settle(callback, false, payload.message, payload);
    }

    const result = await service.store(input.bytes);
    if (result.ok) {
      const payload: WalrusActionCallback = {
        type: "walrus.store.success",
        blobId: result.blobId,
        blobObjectId: result.blobObjectId,
        sizeBytes: result.sizeBytes,
        sha256: sha256Hex(input.bytes),
      };
      const text = `Stored ${result.sizeBytes} bytes on Walrus as blob ${result.blobId}.`;
      return settle(callback, true, text, payload);
    }

    // network_error | config_error -> walrus.error (map message DIRECTLY).
    const payload = walrusError("store", result.errorName, result.message, result.retryable);
    return settle(callback, false, payload.message, payload);
  },
};

export default storeBlobAction;
