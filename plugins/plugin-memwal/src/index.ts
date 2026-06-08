// index.ts — plugin-memwal assembly (A1, Task 4).
//
// Wiring ONLY: assemble the already-built MemwalService and the two thin actions
// into a single ElizaOS Plugin. No new behavior, no new contract types. MemWal
// COMPOSES Walrus (dependency direction MemWal -> Walrus); this plugin is loaded
// ALONGSIDE plugin-walrus so the MemwalService can resolve the long-lived
// WalrusService from the runtime. Walrus/Seal never import MemWal.
//
// Service registration: MemwalService is listed as the CLASS in `services`
// (Plugin.services is `(typeof Service)[]`). The ElizaOS runtime owns the
// lifecycle — it starts ONE long-lived instance via the static start(runtime). The
// service is NOT instantiated here or per action; the actions resolve that single
// instance through runtime.getService(MemwalService.serviceType). The documented
// `as unknown as typeof Service` cast bridges the one type boundary between
// MemwalService's intentionally PRIVATE constructor (construction goes through
// start/fromConfig only) and the framework's public-constructor requirement —
// exactly as plugin-walrus does for WalrusService.
//
// NO `evaluators` key: A1 declares none. The write-on-close lifecycle (checkpoint a
// session as it ends) is A3, NOT an A1 evaluator — A1 exposes only the
// programmatic write/read action surface. NO `providers` either (none in A1).

import type { Plugin, Service } from "@elizaos/core";

import { MemwalService } from "./memwalService.js";
import { writeCheckpointAction } from "./writeCheckpoint.js";
import { readCheckpointAction } from "./readCheckpoint.js";

export const memwalPlugin: Plugin = {
  name: "plugin-memwal",
  description:
    "Checkpoint a chat session as a blob on Walrus and recall it, with a pluggable encrypt/decrypt seam.",
  services: [MemwalService as unknown as typeof Service],
  actions: [writeCheckpointAction, readCheckpointAction],
  providers: [],
};

export default memwalPlugin;
