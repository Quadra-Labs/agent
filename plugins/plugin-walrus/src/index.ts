// index.ts — plugin-walrus assembly (Phase 1, Task 5).
//
// Wiring ONLY: assemble the already-built service, actions, and provider into a
// single ElizaOS Plugin. No new behavior, no new types, no Phase-2+ concepts.
// Phase 1 stores and reads OPAQUE BYTES ONLY — no Seal / MemWal / job / template
// / Intake / signing-handshake concerns appear here.
//
// Service registration: WalrusService is listed as the CLASS in `services`
// (Plugin.services is `(typeof Service)[]`). The ElizaOS runtime owns the
// lifecycle — it starts ONE long-lived instance via the static start(runtime).
// The service is NOT instantiated here or per action; the
// actions and provider resolve that single instance through
// runtime.getService(WalrusService.serviceType).
//
// Actions and the provider are registered as objects (Plugin.actions /
// Plugin.providers). No `evaluators` key: Phase 1 declares none (evaluators are
// post-interaction memory writes — Phase 3). See docs/plugin-shape.md.

import type { Plugin, Service } from "@elizaos/core";

import { WalrusService } from "./walrusService.js";
import { storeBlobAction } from "./storeBlob.js";
import { readBlobAction } from "./readBlob.js";
import { walrusStatusProvider } from "./walrusStatus.js";

export const walrusPlugin: Plugin = {
  name: "plugin-walrus",
  description: "Store and read erasure-coded opaque blobs on Walrus.",
  // The runtime starts ONE long-lived WalrusService from this class via its
  // static start(runtime); it never calls the constructor directly.
  // WalrusService keeps an intentionally PRIVATE constructor (construction goes
  // through start/fromConfig only), which is incompatible with the framework's
  // `(typeof Service)[]` public-constructor requirement. The documented cast
  // bridges that one type boundary without weakening the service invariant —
  // mirrors the ClientWithCoreApi cast in walrusService.ts.
  services: [WalrusService as unknown as typeof Service],
  actions: [storeBlobAction, readBlobAction],
  providers: [walrusStatusProvider],
};

export default walrusPlugin;
