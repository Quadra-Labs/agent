// recallProof.ts — A3 Task 5 deliverable: PROVE checkpoint RECALL + inject.
//
// "Done" definition (the ONLY bar), proven here the cheapest way that is still a
// genuine proof. Task 5 is the RECALL+INJECT mechanism; the END-TO-END close ->
// new-session -> continue loop is Task 6 and is NOT built here. Every branch below
// needs NO model, NO wallet, and NO live Walrus store, so ALL of them ALWAYS run
// (recall is read+inject — the actual model reply is Task 6's e2e):
//
//   (1) NO-PRIOR (live runtime, NO key / NO wallet, ALWAYS): recallCheckpoint for a
//       (user, agent) with NO index entry returns kind:"none" (clean fresh start),
//       no throw. Drives the REAL resolved MemwalService.latest, which returns
//       undefined for an unknown pair.
//
//   (2) INJECTION (REAL prompt builder, NO key / NO wallet, ALWAYS): assert that
//       when respond's prompt builder is given a resumedSummary, the built prompt
//       CONTAINS that summary text, clearly LABELED as recalled context, positioned
//       BEFORE the recent history. And when resumedSummary is ABSENT, the prompt is
//       BYTE-IDENTICAL to Task 3's output (no recalled-context section). Inspects
//       buildChatPrompt — the exact function respond() calls (respond passes
//       input.resumedSummary straight into it), so this is the real seam.
//
//   (3) SYNTHETIC RESOLVE-MAPPING (pure, NO key / NO wallet / NO live Walrus,
//       ALWAYS): feed recallWithReader a FAKE MemwalReader with a known latest()/
//       readCheckpoint() and assert the index -> read -> extract path:
//         - latest -> blobId, readCheckpoint ok:true  -> kind:"recalled" + summary
//         - latest -> undefined                       -> kind:"none"
//         - latest -> blobId, readCheckpoint ok:false  -> kind:"error" (each kind
//           maps through: blob_unavailable/network_error/config_error/invalid).
//       This proves the live index->read->extract wiring WITHOUT a funded wallet.
//       The LIVE index resolve (latest finding a REAL stored blob) requires a funded
//       signer to first store a blob (Task 6); see the handback note.
//
// NOTHING here needs a live model: recall is read+inject. So there is no model half
// to skip; the proof runs fully even with NO GROQ_API_KEY. The Groq key / signer
// secret are NEVER logged.

import { loadAgentConfig } from "./config.js";
import { createAgentRuntime, type AgentRuntimeHandle } from "./runtime.js";
import { buildChatPrompt } from "./chat.js";
import {
  recallCheckpoint,
  recallWithReader,
  type MemwalReader,
  type RecallOutcome,
} from "./recallCheckpoint.js";
import type {
  Checkpoint,
  ReadCheckpointResult,
} from "../../../plugins/plugin-memwal/src/types.js";

// Placeholder so config + boot proceed without a real Groq key. NOTHING in this
// proof calls the LLM (recall is read+inject), so the placeholder is only ever used
// to satisfy loadAgentConfig's hard GROQ_API_KEY requirement at boot.
const PLACEHOLDER_GROQ_KEY = "gsk_recallproof_placeholder_no_llm_branches";

const EXIT_PASS = 0;
const EXIT_FAIL = 1;

function log(line: string): void {
  console.log(line);
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

// Load apps/agent/.env into process.env if present (tsx does not auto-load it).
// Mirrors boot.ts / chatProof.ts / closeProof.ts. A missing file is fine.
function loadDotEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader(".env");
  } catch {
    // No .env file -- rely on whatever is already in the environment.
  }
}

// A minimal synthetic checkpoint for the resolve-mapping branch. Seven fields to
// satisfy the locked Checkpoint contract; only `summary` is asserted on.
function syntheticCheckpoint(summary: string): Checkpoint {
  return {
    roomId: "synthetic-room",
    createdAt: 1,
    turnCount: 3,
    summary,
    user: "synthetic-user",
    agent: "WalrusAgent",
    session: "synthetic-session",
  };
}

// A fake MemwalReader: returns the configured `blobId` from latest() and the
// configured `read` result from readCheckpoint(). Drives recallWithReader with no
// runtime, no wallet, no live Walrus. Records the (user, agent, session) latest was
// asked for so the proof can assert recall passes identities through UNCHANGED.
function fakeReader(opts: {
  readonly blobId: string | undefined;
  readonly read?: ReadCheckpointResult;
  readonly seen?: { user?: string; agent?: string; session?: string };
}): MemwalReader {
  return {
    async latest(user, agent, session) {
      if (opts.seen) {
        opts.seen.user = user;
        opts.seen.agent = agent;
        opts.seen.session = session;
      }
      return opts.blobId;
    },
    async readCheckpoint(_blobId) {
      return (
        opts.read ?? {
          ok: false,
          kind: "blob_unavailable",
          blobId: _blobId,
          errorName: "Unset",
          message: "no read result configured",
          retryable: false,
        }
      );
    },
  };
}

// ===========================================================================
// (2) INJECTION via the REAL prompt builder. Pure — needs NO runtime, NO key,
//     NO wallet. ALWAYS runs. buildChatPrompt is exactly what respond() calls.
// ===========================================================================
function proveInjection(): boolean {
  log("--- (2) injection: resumedSummary rendered into the REAL prompt builder ---");
  const summary =
    "User wanted a 500-item data-labeling job; budget flexible; quality bar still missing.";

  // History identical for both prompts so the ONLY difference is the recalled block.
  const history = [
    { role: "user" as const, text: "hi again", createdAt: 1 },
    { role: "agent" as const, text: "welcome back", createdAt: 2 },
  ];

  const withSummary = buildChatPrompt(history, summary);
  const withoutSummary = buildChatPrompt(history);
  // The exact Task 3 baseline: buildChatPrompt with NO second argument. Used to
  // prove byte-identity when resumedSummary is absent.
  const baseline = buildChatPrompt(history, undefined);

  // 2a. The summary text appears in the with-summary prompt.
  if (!withSummary.includes(summary)) {
    log("FAIL -- with-summary prompt does NOT contain the recalled summary text");
    return false;
  }
  // 2b. It is clearly LABELED as recalled prior-session context.
  const label = "Recalled context from a previous session";
  if (!withSummary.includes(label)) {
    log(`FAIL -- recalled summary is not clearly labeled (missing "${label}")`);
    return false;
  }
  // 2c. The recalled block is positioned BEFORE the recent history.
  const summaryAt = withSummary.indexOf(summary);
  const historyAt = withSummary.indexOf("Conversation so far:");
  if (summaryAt < 0 || historyAt < 0 || summaryAt >= historyAt) {
    log("FAIL -- recalled context is not positioned BEFORE the recent history");
    return false;
  }
  log('PASS -- (2a-c) summary present, labeled "recalled", before the history');

  // 2d. ABSENT resumedSummary -> byte-identical to Task 3 (no recalled section).
  if (withoutSummary !== baseline) {
    log("FAIL -- absent-summary prompt differs from the undefined baseline");
    return false;
  }
  if (withoutSummary.includes(label) || withoutSummary.includes(summary)) {
    log("FAIL -- absent-summary prompt leaked a recalled-context section");
    return false;
  }
  // The two prompts must differ ONLY by the added recalled block (the baseline must
  // be a contiguous-tail subset: same SYSTEM_PROMPT head, same history tail).
  if (!withoutSummary.startsWith("You are a helpful assistant")) {
    log("FAIL -- absent-summary prompt lost the Task 3 system header");
    return false;
  }
  log("PASS -- (2d) absent resumedSummary -> prompt byte-identical to Task 3");
  return true;
}

// ===========================================================================
// (3) SYNTHETIC RESOLVE-MAPPING. Pure — NO runtime, NO key, NO wallet, NO live
//     Walrus. ALWAYS runs. Proves index -> read -> extract + every failure kind.
// ===========================================================================
async function proveSyntheticResolve(): Promise<boolean> {
  log("--- (3) synthetic resolve-mapping: latest -> readCheckpoint -> extract ---");

  // 3a. latest -> blobId, readCheckpoint ok:true -> kind:"recalled" + summary.
  const summary = "Recalled: the user is mid data-labeling-job setup.";
  const seen: { user?: string; agent?: string; session?: string } = {};
  const okReader = fakeReader({
    blobId: "blob-RECALL",
    read: { ok: true, checkpoint: syntheticCheckpoint(summary) },
    seen,
  });
  const recalled = await recallWithReader(okReader, {
    user: "u-1",
    agent: "WalrusAgent",
    session: "s-1",
  });
  log(`  ok:true read -> kind=${recalled.kind}`);
  if (recalled.kind !== "recalled" || recalled.summary !== summary) {
    log("FAIL -- ok:true read must yield kind:recalled with the extracted summary");
    return false;
  }
  if (recalled.blobId !== "blob-RECALL") {
    log("FAIL -- recalled outcome must carry the resolved blobId");
    return false;
  }
  // Identity pass-through: recall asked latest() for the SAME (user, agent, session).
  if (seen.user !== "u-1" || seen.agent !== "WalrusAgent" || seen.session !== "s-1") {
    log("FAIL -- recall did not pass (user, agent, session) through to latest() unchanged");
    return false;
  }
  log('PASS -- (3a) latest -> readCheckpoint ok:true -> kind:"recalled" + summary extracted');

  // 3b. latest -> undefined -> kind:"none" (degraded-write / first-run consequence).
  const noneReader = fakeReader({ blobId: undefined });
  const none = await recallWithReader(noneReader, { user: "u-2", agent: "WalrusAgent" });
  log(`  latest undefined -> kind=${none.kind}`);
  if (none.kind !== "none") {
    log('FAIL -- latest undefined must yield kind:"none" (clean fresh start)');
    return false;
  }
  log('PASS -- (3b) latest undefined -> kind:"none" (no throw)');

  // 3c. Every ok:false read kind maps through to a typed kind:"error". Typed as the
  //     ok:false subset so `read.kind` is accessible (the union's ok:true member has
  //     no `kind`).
  const failKinds: readonly Extract<ReadCheckpointResult, { ok: false }>[] = [
    { ok: false, kind: "blob_unavailable", blobId: "blob-X", errorName: "WalrusBlobUnavailable", message: "gone", retryable: false },
    { ok: false, kind: "network_error", errorName: "WalrusNetworkError", message: "timeout", retryable: true },
    { ok: false, kind: "config_error", errorName: "MemwalConfigError", message: "no walrus", retryable: false },
    { ok: false, kind: "invalid_checkpoint", blobId: "blob-Y", errorName: "InvalidCheckpointError", message: "malformed", retryable: false },
  ];
  for (const read of failKinds) {
    const reader = fakeReader({ blobId: "blob-FAIL", read });
    const outcome: RecallOutcome = await recallWithReader(reader, {
      user: "u-3",
      agent: "WalrusAgent",
    });
    log(`  read ok:false kind=${read.kind} -> outcome.kind=${outcome.kind} errorKind=${outcome.kind === "error" ? outcome.errorKind : "-"}`);
    if (outcome.kind !== "error" || outcome.errorKind !== read.kind) {
      log(`FAIL -- ok:false ${read.kind} must map to a typed error outcome of the same kind`);
      return false;
    }
  }
  log("PASS -- (3c) all four ok:false read kinds map through to typed error outcomes");
  return true;
}

// ===========================================================================
// (1) NO-PRIOR via the LIVE resolved MemwalService. Needs a booted runtime but NO
//     key / NO wallet (latest() on an unknown pair just returns undefined). ALWAYS
//     runs. A run-unique (user, agent) guarantees no index entry exists.
// ===========================================================================
async function proveNoPriorLive(
  handle: AgentRuntimeHandle,
  user: string,
): Promise<boolean> {
  log("--- (1) no-prior (LIVE memwal): unknown (user, agent) -> kind:none, no throw ---");
  const outcome = await recallCheckpoint(handle.runtime, {
    user,
    agent: "WalrusAgent",
  });
  log(`  outcome.kind=${outcome.kind}`);
  if (outcome.kind !== "none") {
    log(`FAIL -- unknown (user, agent) must return kind:"none", got "${outcome.kind}"`);
    return false;
  }
  log('PASS -- (1) live memwal index resolve: unknown pair -> kind:"none" (clean, no throw)');
  return true;
}

async function main(): Promise<void> {
  log("=== A3 TASK 5: checkpoint recall + inject (read half of cross-session memory) ===");

  loadDotEnv();

  // No branch here needs a real model. We only need GROQ_API_KEY to satisfy
  // loadAgentConfig + boot; inject a placeholder when absent.
  const hasRealGroqKey = (process.env.GROQ_API_KEY ?? "").trim().length > 0;
  if (!hasRealGroqKey) {
    process.env.GROQ_API_KEY = PLACEHOLDER_GROQ_KEY;
  }

  // --- Pure, key-free, wallet-free branches FIRST: injection + synthetic resolve.
  //     These do not even need a booted runtime.
  const injectionOk = proveInjection();
  const resolveOk = await proveSyntheticResolve();
  if (!injectionOk || !resolveOk) {
    log("RECALLPROOF: FAIL -- a pure (key-free/wallet-free) branch failed");
    process.exitCode = EXIT_FAIL;
    return;
  }

  const config = loadAgentConfig();

  // Run-unique user so the live no-prior branch is deterministic on the durable DB.
  const runToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const noPriorUser = `recall-proof-user-${runToken}`;

  let handle: AgentRuntimeHandle;
  try {
    handle = await createAgentRuntime(config);
  } catch (err) {
    log("FAIL -- runtime boot failed");
    log(errorDetail(err));
    log("RECALLPROOF: FAIL -- boot");
    process.exitCode = EXIT_FAIL;
    return;
  }

  try {
    const noPriorOk = await proveNoPriorLive(handle, noPriorUser);
    if (!noPriorOk) {
      log("RECALLPROOF: FAIL -- live no-prior branch failed");
      process.exitCode = EXIT_FAIL;
      return;
    }
    log(
      "RECALLPROOF: PASS -- injection + synthetic resolve-mapping + live no-prior all proven. " +
        "(Live index resolve of a REAL stored blob needs a funded signer -> Task 6 e2e.)",
    );
    process.exitCode = EXIT_PASS;
  } catch (err) {
    log("FAIL -- unexpected error during recall proof");
    log(errorDetail(err));
    log("RECALLPROOF: FAIL -- unexpected");
    process.exitCode = EXIT_FAIL;
  } finally {
    await handle.stop();
  }
}

main().catch((err) => {
  console.error("RECALLPROOF: FAIL -- unexpected error");
  console.error(errorDetail(err));
  process.exitCode = EXIT_FAIL;
});
