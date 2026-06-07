// walrusStatus.ts — WALRUS_STATUS provider (Phase 1, Task 4).
//
// Surfaces the long-lived WalrusService's IN-MEMORY recently-stored handles into
// the agent's context. It resolves the SAME long-lived service the Task-3 actions
// use (runtime.getService(WalrusService.serviceType)) and reads recentHandles().
// It writes nothing back: the service self-records on store(); the provider is
// strictly read-only.
//
// Hard boundaries (PHASE1_PLAN.md "Phase 2+ leakage"): in-memory handles ONLY —
// NO persistence, indexing, or durability (a durable handle index leans toward
// MemWal, which is Phase 3), and NO Seal / MemWal / job / template / Intake /
// signing / Phase-2+ identifiers in any value, key, name, or comment.
//
// Injection pattern ported from phase0/spike/eliza_standalone/p3_C_memwal_on_answer.mjs
// (recalled context folded into the prompt), repackaged as a real ElizaOS Provider.

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";

import { WalrusService } from "./walrusService.js";
import type { StoredBlobHandle } from "./types.js";

export const WALRUS_STATUS = "WALRUS_STATUS";

// How many handles to spell out in the prompt `text`. The full set still flows
// through `data`/`values`; capping only the prose avoids prompt bloat (a Task-4
// formatting detail) while the service bound (MAX_RECENT_HANDLES) caps the rest.
const TEXT_HANDLE_LIMIT = 5;

// Empty/placeholder result, reused for the unresolved-service and no-handles
// paths. The provider degrades gracefully — it never throws.
const emptyResult = (text: string): ProviderResult => ({
  text,
  values: { walrusRecentCount: 0 },
  data: { recentHandles: [] as StoredBlobHandle[] },
});

const formatHandle = (h: StoredBlobHandle): string =>
  `- ${h.blobId} (${h.sizeBytes} bytes` +
  (h.blobObjectId === undefined ? "" : `, object ${h.blobObjectId}`) +
  `)`;

export const walrusStatusProvider: Provider = {
  name: WALRUS_STATUS,
  description:
    "Recently stored Walrus blob handles currently in memory: blobId, size, and Sui object id.",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService<WalrusService>(WalrusService.serviceType);
    if (service === null || service === undefined) {
      // Missing/unresolved service: degrade gracefully, do not throw.
      return emptyResult("Walrus service is not available; no recently stored blobs.");
    }

    const handles = service.recentHandles();
    if (handles.length === 0) {
      return emptyResult("No blobs have been stored on Walrus yet.");
    }

    // `data`/`values` carry the full in-memory set; `text` shows only the newest
    // few to keep the prompt tidy.
    const shown = handles.slice(0, TEXT_HANDLE_LIMIT);
    const more = handles.length - shown.length;
    const lines = [
      `Recently stored Walrus blobs (${handles.length} in memory, newest first):`,
      ...shown.map(formatHandle),
    ];
    if (more > 0) lines.push(`- ...and ${more} more.`);

    return {
      text: lines.join("\n"),
      values: {
        walrusRecentCount: handles.length,
        // Non-empty branch guarantees handles.length > 0, so handles[0] is present.
        walrusLatestBlobId: handles[0].blobId,
      },
      // The service accessor already isolates its own state; this second shallow
      // copy makes the provider's output self-contained so a downstream consumer
      // cannot mutate the array (or its handles) it received from us.
      data: { recentHandles: handles.map((h) => ({ ...h })) },
    };
  },
};

export default walrusStatusProvider;
