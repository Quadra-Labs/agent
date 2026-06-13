// index.ts — plugin-walrus assembly: wire the service (registered as a CLASS; the
// runtime starts ONE long-lived instance via static start), actions, and provider into
// one Plugin. Opaque bytes only; no evaluators.

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
