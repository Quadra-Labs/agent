// readCheckpoint.ts — MEMWAL_READ_CHECKPOINT action (A1, Task 4).
//
// A THIN delegate (mirrors plugin-walrus/src/readBlob.ts): resolve the SAME
// long-lived MemwalService via runtime.getService; if absent, emit a typed
// memwal.error callback (do NOT throw); resolve the blobId off `options`; call
// service.readCheckpoint; and map the typed ReadCheckpointResult DIRECTLY onto the
// locked MemwalActionCallback union. Error text is copied from result.message.
//
// On success the callback carries the PARSED Checkpoint (the full record) so the
// caller reproduces the session end to end. Every read failure kind
// (blob_unavailable / network_error / config_error / invalid_checkpoint) collapses
// to a single memwal.error callback with operation "read" — never a throw, never
// null.

import type { Action } from "@elizaos/core";

import { MemwalService } from "./memwalService.js";
import { resolveBlobId } from "./actionInput.js";
import { settle, memwalError } from "./actionCallback.js";
import type { MemwalActionCallback } from "./actionCallback.js";

export const MEMWAL_READ_CHECKPOINT = "MEMWAL_READ_CHECKPOINT";

export const readCheckpointAction: Action = {
  name: MEMWAL_READ_CHECKPOINT,
  similes: ["READ_CHECKPOINT", "MEMWAL_READ", "LOAD_CHECKPOINT", "RESUME_CHECKPOINT"],
  description:
    "Read a session Checkpoint from Walrus by blobId (from options) via MemWal and return the parsed record.",
  // Programmatic action: the blobId is on `options`, which `validate`
  // (runtime/message/state only) cannot see — so validate stays false and the
  // handler is called directly. A3 owns the conversational resume trigger.
  validate: async () => false,
  handler: async (_runtime, _message, _state, options, callback) => {
    const service = _runtime.getService<MemwalService>(MemwalService.serviceType);
    if (service === null || service === undefined) {
      const payload = memwalError(
        "read",
        "MemwalServiceUnavailable",
        "memwal service is not registered",
        false,
      );
      return settle(callback, false, payload.message, payload);
    }

    const input = resolveBlobId(options);
    if (!input.ok) {
      const payload = memwalError("read", input.errorName, input.message, false);
      return settle(callback, false, payload.message, payload);
    }

    const result = await service.readCheckpoint(input.blobId);
    if (result.ok) {
      const payload: MemwalActionCallback = {
        type: "memwal.read.success",
        checkpoint: result.checkpoint,
      };
      const text = `Read checkpoint from Walrus blob ${input.blobId}.`;
      return settle(callback, true, text, payload);
    }

    // blob_unavailable | network_error | config_error | invalid_checkpoint ->
    // memwal.error (map message DIRECTLY; retryable comes from the typed result).
    const payload = memwalError("read", result.errorName, result.message, result.retryable);
    return settle(callback, false, payload.message, payload);
  },
};

export default readCheckpointAction;
