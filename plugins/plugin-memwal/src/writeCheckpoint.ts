// writeCheckpoint.ts — MEMWAL_WRITE_CHECKPOINT action (A1, Task 4).
//
// A THIN delegate (mirrors plugin-walrus/src/storeBlob.ts): resolve the long-lived
// MemwalService via runtime.getService (NEVER constructed per action); if absent,
// emit a typed memwal.error callback (do NOT throw); validate the structured
// Checkpoint off `options`; call service.writeCheckpoint; and map the typed
// WriteCheckpointResult DIRECTLY onto the locked MemwalActionCallback union. Error
// text is copied from result.message — actions never invent it.
//
// INPUT DIFFERS FROM WALRUS: storeBlob reads bytes from the message text; A1 actions
// are invoked PROGRAMMATICALLY, so the Checkpoint (a structured record) is taken
// from `options`, not free-text message parsing. The conversational/lifecycle write
// trigger is A3, not this action.

import type { Action } from "@elizaos/core";

import { MemwalService } from "./memwalService.js";
import { resolveCheckpoint } from "./actionInput.js";
import { settle, memwalError } from "./actionCallback.js";
import type { MemwalActionCallback } from "./actionCallback.js";

export const MEMWAL_WRITE_CHECKPOINT = "MEMWAL_WRITE_CHECKPOINT";

export const writeCheckpointAction: Action = {
  name: MEMWAL_WRITE_CHECKPOINT,
  similes: ["WRITE_CHECKPOINT", "MEMWAL_WRITE", "SAVE_CHECKPOINT", "CHECKPOINT_SESSION"],
  description:
    "Write a session Checkpoint (structured record from options) to Walrus via MemWal and return its blobId.",
  // Programmatic action: input is the structured Checkpoint on `options`, which
  // `validate` (runtime/message/state only — no options) cannot see. So validate
  // stays false: this action is not eligible for arbitrary chat (A3 owns the
  // conversational trigger). Direct/options invocation calls the handler.
  validate: async () => false,
  handler: async (_runtime, _message, _state, options, callback) => {
    const service = _runtime.getService<MemwalService>(MemwalService.serviceType);
    if (service === null || service === undefined) {
      const payload = memwalError(
        "write",
        "MemwalServiceUnavailable",
        "memwal service is not registered",
        false,
      );
      return settle(callback, false, payload.message, payload);
    }

    const input = resolveCheckpoint(options);
    if (!input.ok) {
      const payload = memwalError("write", input.errorName, input.message, false);
      return settle(callback, false, payload.message, payload);
    }

    const result = await service.writeCheckpoint(input.checkpoint);
    if (result.ok) {
      const payload: MemwalActionCallback = {
        type: "memwal.write.success",
        blobId: result.blobId,
        // The service's `indexed` is additive/optional; surface it as a concrete
        // boolean (false === not recorded / no index) on the callback.
        indexed: result.indexed === true,
      };
      const text = `Wrote checkpoint to Walrus as blob ${result.blobId} (indexed: ${payload.indexed}).`;
      return settle(callback, true, text, payload);
    }

    // network_error | config_error -> memwal.error (map message DIRECTLY).
    const payload = memwalError("write", result.errorName, result.message, result.retryable);
    return settle(callback, false, payload.message, payload);
  },
};

export default writeCheckpointAction;
