// e2eProof.ts — A3 Task 6 deliverable: the A3 EXIT-GATE proof.
//
// Exit gate (verbatim): "Memory survives across sessions — close a session, start
// a new one, the agent continues with the recalled checkpoint."
//
// This is the FINAL A3 task. It strings the REAL Task 3-5 pieces together end to end
// through the booted runtime — nothing is re-implemented here, everything is COMPOSED:
//   - session 1 turns via Task-3 respond() -> persist to plugin-sql
//   - close via Task-4 closeSession() -> LLM-summarize + REAL MemwalService.writeCheckpoint
//   - a NEW session via Task-5 recallCheckpoint() -> latest() (index) -> readCheckpoint()
//   - continue via Task-3 respond({ resumedSummary }) -> the reply CONTINUES from a
//     session-1 fact the agent was NEVER told in session 2.
//
// THE FUNDED-SIGNER REALITY (honest tiers, no faked gate). The live Walrus store needs
// a funded testnet signer. Without one, closeSession's REAL write returns config_error
// and NO blob/index entry can exist, so the live store + live index-resolve link is
// genuinely unreachable. We therefore run in explicit, LABELED tiers and exit 0 on the
// HIGHEST tier reachable in this environment:
//
//   TIER FULL      (real Groq key AND funded signer): the literal exit-gate sentence,
//                  exercised live. session1 -> closeSession ok:true (indexed:true) with
//                  a REAL blobId -> REBOOT a fresh runtime handle against the SAME DB
//                  (durability beyond process memory) -> recallCheckpoint resolves the
//                  blobId from the index -> readCheckpoint ok:true -> respond continues
//                  from the fact. Asserts indexed:true so recall went through the index,
//                  not a same-process cache. Prints E2E: PASS (FULL).
//
//   TIER NO-WALLET (real Groq key, NO funded signer): prove EVERYTHING up to the live
//                  store, AND prove the recall+continue half against a DIRECTLY-SUPPLIED
//                  checkpoint summary (the live store/index is unreachable without gas):
//                    (a) session1 persists + LLM-summarizes (closeSession reaches the
//                        write step), (b) closeSession surfaces the REAL config_error
//                        (no false success), (c) given a recalled summary, respond's reply
//                        CONTINUES from the fact with that summary in the REAL prompt.
//                  Prints E2E: PASS (NO-WALLET: ...), naming the ONE unproven link.
//
//   TIER NO-KEY    (no Groq key): SKIP cleanly (the gate needs the model to summarize +
//                  continue). Still runs the model-free STRUCTURAL assertion (the recalled
//                  summary renders into the real prompt, before the history). Exit 0.
//
// The tier SELECTION is logged up front so the reader knows exactly what was proven this
// run. MemWal composes Walrus (never the reverse). No template authoring / scoring /
// settlement / registration. The Groq key and the signer secret are NEVER logged.

import type { IAgentRuntime } from "@elizaos/core";

import { loadAgentConfig, type AgentConfig } from "./config.js";
import { createAgentRuntime, type AgentRuntimeHandle } from "./runtime.js";
import { respond, buildChatPrompt } from "./chat.js";
import { listTurns } from "./chatMemory.js";
import { closeSession, type CloseOutcome } from "./closeSession.js";
import { recallCheckpoint, type RecallOutcome } from "./recallCheckpoint.js";

// Placeholder so config + boot proceed without a real Groq key (the NO-KEY tier still
// boots to run the model-free structural assertion). The model halves only run when a
// REAL key is detected BEFORE this placeholder is applied.
const PLACEHOLDER_GROQ_KEY = "gsk_e2eproof_placeholder_structural_only";

const EXIT_PASS = 0;
const EXIT_SKIP = 0; // a clean tier downgrade is a NON-FAILURE
const EXIT_FAIL = 1;

// The fixed, checkable session-1 FACT. A distinctive token unlikely to appear by chance,
// so "the reply continues from the fact" is a real signal, not a coincidence. Session 2
// is NEVER told this word directly — the agent can only know it via the recalled summary.
const SECRET_WORD = "moonquake";

// A stable (user, agent) identity for the gate. recallCheckpoint MUST be asked for the
// SAME (user, agent) the writer recorded under, or the namespace will not resolve.
const GATE_USER = "e2e-gate-user";
const GATE_AGENT = "WalrusAgent"; // matches runtime.AGENT_NAME

function log(line: string): void {
  console.log(line);
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

// Load apps/agent/.env into process.env if present (tsx does not auto-load it). A
// missing file is fine. Mirrors the sibling proofs.
function loadDotEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader(".env");
  } catch {
    // No .env file -- rely on whatever is already in the environment.
  }
}

// Does a reply CONTINUE from the session-1 fact? Case-insensitive substring match on the
// distinctive secret word. The word was never given to session 2, so its presence in the
// reply means the recalled summary carried it across the session boundary.
function replyReflectsFact(reply: string): boolean {
  return reply.toLowerCase().includes(SECRET_WORD.toLowerCase());
}

// Drive a few session-1 turns through the REAL Task-3 respond(), establishing the
// checkable FACT. Turns persist to plugin-sql. Returns nothing; the caller reads them
// back via listTurns / closeSession.
async function driveSession1(runtime: IAgentRuntime, roomId: string): Promise<void> {
  log("--- session 1: establish a checkable FACT via respond() (persists to plugin-sql) ---");
  await respond(runtime, {
    roomId,
    user: GATE_USER,
    text: `Please remember this for later: the secret word is ${SECRET_WORD}.`,
  });
  await respond(runtime, {
    roomId,
    user: GATE_USER,
    text: "Also, I am setting up a 500-item data-labeling job; budget is flexible.",
  });
  const turns = await listTurns(runtime, roomId);
  log(`  session 1 persisted ${turns.length} turns (user + agent).`);
}

// Continue in a NEW session: inject `resumedSummary` into the REAL respond() and assert
// (i) the recalled summary is in the EXACT prompt the model received (via onPrompt), and
// (ii) the model reply CONTINUES from the session-1 fact (references the secret word it
// was never told in session 2). Returns true on a clean continuation.
async function continueFromSummary(
  runtime: IAgentRuntime,
  roomId: string,
  resumedSummary: string,
): Promise<boolean> {
  let injectedPrompt = "";
  const reply = await respond(runtime, {
    roomId,
    user: GATE_USER,
    // The user does NOT restate the secret word — the agent can only answer from the
    // recalled summary, which is the whole point of the gate.
    text: "Continuing our earlier chat: what was the secret word I asked you to remember?",
    resumedSummary,
    onPrompt: (p) => {
      injectedPrompt = p;
    },
  });

  // (i) The recalled summary must be in the REAL prompt sent to the model, positioned as
  //     recalled context ahead of the recent history (the Task-5 inject seam, live).
  if (!injectedPrompt.includes(resumedSummary)) {
    log("FAIL -- the recalled summary was NOT injected into the real continuation prompt");
    return false;
  }
  if (!injectedPrompt.includes("Recalled context from a previous session")) {
    log("FAIL -- the injected summary was not labeled as recalled prior-session context");
    return false;
  }
  log("PASS -- the recalled summary is present + labeled in the REAL continuation prompt");

  // (ii) The reply must continue from the fact: it references the secret word that only
  //      the recalled summary could have carried across the session boundary.
  log(`  continuation reply (len=${reply.length}) received`);
  if (!replyReflectsFact(reply)) {
    log(
      `FAIL -- the reply does NOT reflect the session-1 fact ("${SECRET_WORD}"). ` +
        "The agent did not continue from the recalled checkpoint.",
    );
    return false;
  }
  log(`PASS -- the reply CONTINUES from the session-1 fact ("${SECRET_WORD}") it was never told in session 2`);
  return true;
}

// ===========================================================================
// TIER NO-KEY: model-free structural assertion. No model, no wallet. Proves the
// recalled summary renders into the REAL prompt builder ahead of the history, so the
// inject seam the gate relies on is wired even when the model halves cannot run.
// ===========================================================================
function proveStructuralInject(): boolean {
  log("--- structural inject (model-free): recalled summary renders into the real prompt ---");
  const summary = `Recalled: the user told me the secret word is ${SECRET_WORD}; mid 500-item job setup.`;
  const history = [
    { role: "user" as const, text: "hi again", createdAt: 1 },
    { role: "agent" as const, text: "welcome back", createdAt: 2 },
  ];
  const prompt = buildChatPrompt(history, summary);

  if (!prompt.includes(summary)) {
    log("FAIL -- the recalled summary is not present in the built prompt");
    return false;
  }
  const summaryAt = prompt.indexOf(summary);
  const historyAt = prompt.indexOf("Conversation so far:");
  if (summaryAt < 0 || historyAt < 0 || summaryAt >= historyAt) {
    log("FAIL -- the recalled context is not positioned BEFORE the recent history");
    return false;
  }
  log("PASS -- recalled summary renders into the real prompt, ahead of the history");
  return true;
}

// ===========================================================================
// TIER NO-WALLET: prove every gate link reachable without a funded signer. The
// live Walrus store + live index-resolve is the ONE link that needs gas.
// ===========================================================================
async function runNoWalletTier(handle: AgentRuntimeHandle, runToken: string): Promise<number> {
  const runtime = handle.runtime;
  const session1Room = `e2e-no-wallet-s1-${runToken}`;
  const session2Room = `e2e-no-wallet-s2-${runToken}`;

  // (a) session 1 persists + the close path LLM-summarizes and REACHES the write step.
  await driveSession1(runtime, session1Room);

  log("--- close session 1 (REAL closeSession: LLM-summarize -> REAL MemwalService write) ---");
  const close: CloseOutcome = await closeSession(runtime, {
    roomId: session1Room,
    user: GATE_USER,
    agent: GATE_AGENT,
    session: "e2e-no-wallet-session-1",
  });
  log(`  close outcome.kind=${close.kind}`);

  // (b) With NO funded signer, the REAL write returns config_error. The gate must NOT
  //     claim a false success: assert the typed config_error specifically. (A summarize
  //     failure throws before this and is caught by main; reaching here means summarize
  //     succeeded and the WRITE was attempted, which is exactly the link we are proving.)
  if (close.kind !== "error") {
    log(
      `FAIL -- NO-WALLET expected closeSession to surface kind:"error" (no funded signer), ` +
        `got "${close.kind}". A funded key would make this the FULL tier instead.`,
    );
    return EXIT_FAIL;
  }
  if (close.errorKind !== "config_error") {
    log(
      `FAIL -- NO-WALLET expected errorKind:"config_error" (signer-less Walrus), got ` +
        `"${close.errorKind}". The live store link is not proven by a different error.`,
    );
    return EXIT_FAIL;
  }
  log(
    `PASS -- closeSession reached the REAL write and surfaced config_error (errorName=${close.errorName}); ` +
      "NO false success claimed.",
  );

  // The live store/index is unreachable without gas, so we cannot resolve a REAL blobId
  // from the index. Confirm that consequence honestly: recall returns "none" because no
  // index entry exists (the degraded/no-write read-side consequence), then prove the
  // recall+CONTINUE half against a DIRECTLY-SUPPLIED summary (bypassing the unreachable
  // live store) so the downstream of the gate is fully exercised.
  log("--- new session: recallCheckpoint (live index) -> expect none (no blob was stored) ---");
  const recall: RecallOutcome = await recallCheckpoint(runtime, {
    user: GATE_USER,
    agent: GATE_AGENT,
  });
  log(`  recall outcome.kind=${recall.kind}`);
  if (recall.kind !== "none") {
    log(
      `FAIL -- with no stored blob, recall should be kind:"none", got "${recall.kind}". ` +
        "Unexpected index state.",
    );
    return EXIT_FAIL;
  }
  log('PASS -- live index resolve returns "none" (no blob stored, as expected without gas)');

  // The summary a successful close+recall WOULD have produced — supplied directly here so
  // the continue half is proven without the live store. In the FULL tier this exact
  // summary comes from recallCheckpoint(...).summary instead.
  const directSummary =
    `In the previous session the user said the secret word is ${SECRET_WORD}, ` +
    "and began setting up a 500-item data-labeling job with a flexible budget.";

  log("--- continue: respond({ resumedSummary }) must continue from the session-1 fact ---");
  const continued = await continueFromSummary(runtime, session2Room, directSummary);
  if (!continued) {
    return EXIT_FAIL;
  }

  log("");
  log(
    "E2E: PASS (NO-WALLET: gate proven EXCEPT the live Walrus store + live index-resolve, " +
      "which need a funded signer).",
  );
  log(
    "  Proven this run: session-1 persistence (respond -> plugin-sql), closeSession " +
      "LLM-summarize reaching the REAL write, the REAL write surfacing config_error (no " +
      "false success), and recall->continue from a recalled summary (summary present + " +
      "labeled in the REAL prompt, reply reflects the fact).",
  );
  log(
    `  UNPROVEN until a funded WALRUS_SIGNER_KEY is supplied: exactly ONE link — the live ` +
      "Walrus store writing a durable blob + the (user,agent) index recording it + " +
      "recallCheckpoint resolving THAT real blobId back. Supplying a funded key flips this " +
      "run to TIER FULL automatically (no code change).",
  );
  return EXIT_PASS;
}

// ===========================================================================
// TIER FULL: the literal exit-gate sentence, exercised live end to end, with a
// REBOOT between sessions to prove durability beyond process memory.
// ===========================================================================
async function runFullTier(
  config: AgentConfig,
  handle1: AgentRuntimeHandle,
  runToken: string,
): Promise<{ code: number; rebooted?: AgentRuntimeHandle }> {
  const session1Room = `e2e-full-s1-${runToken}`;
  const session2Room = `e2e-full-s2-${runToken}`;
  const sessionId = `e2e-full-session-1-${runToken}`;

  // session 1 + close, on the FIRST handle.
  await driveSession1(handle1.runtime, session1Room);

  log("--- close session 1 (REAL closeSession: LLM-summarize -> live Walrus store) ---");
  const close: CloseOutcome = await closeSession(handle1.runtime, {
    roomId: session1Room,
    user: GATE_USER,
    agent: GATE_AGENT,
    session: sessionId,
  });
  log(`  close outcome.kind=${close.kind}`);

  // The FULL gate needs a durable blob AND a landed index entry: recall must go through
  // the index, not a same-process cache, so we require indexed:true (kind:"saved"). A
  // "degraded" (indexed:false) blob is durable but recall-by-index would miss it, which
  // would not prove the index-resolve link — so we treat it as a FULL-tier failure and
  // say so (the blob is still durable; this is about the index link the gate asserts).
  if (close.kind === "error") {
    log(
      `FAIL -- FULL tier: closeSession returned a typed error (${close.errorKind}: ${close.message}). ` +
        "The funded signer did not complete the live store.",
    );
    return { code: EXIT_FAIL };
  }
  if (close.kind === "empty") {
    log("FAIL -- FULL tier: closeSession reported empty; session 1 did not persist turns.");
    return { code: EXIT_FAIL };
  }
  if (close.kind === "degraded") {
    log(
      `FAIL -- FULL tier: closeSession is DEGRADED (blob ${close.blobId} durable but indexed:false). ` +
        "Recall-by-index would miss it, so the index-resolve link is not proven. " +
        "(Re-run; the blob IS durable, but the gate needs indexed:true.)",
    );
    return { code: EXIT_FAIL };
  }
  // kind === "saved": durable blob AND landed index entry.
  log(`PASS -- live store ok: blob ${close.blobId} durable on Walrus AND indexed (indexed:true)`);

  // REBOOT a FRESH runtime handle against the SAME DB. This proves recall reads the index
  // + the blob from DURABLE storage, not from session-1 process memory.
  log("--- REBOOT: fresh runtime handle against the same DB (durability beyond process memory) ---");
  await handle1.stop();
  const handle2 = await createAgentRuntime(config);

  log("--- new session: recallCheckpoint (live index resolve -> live readCheckpoint) ---");
  const recall: RecallOutcome = await recallCheckpoint(handle2.runtime, {
    user: GATE_USER,
    agent: GATE_AGENT,
  });
  log(`  recall outcome.kind=${recall.kind}`);
  if (recall.kind !== "recalled") {
    const why =
      recall.kind === "error"
        ? `typed error ${recall.errorKind}: ${recall.message}`
        : "no index entry resolved (none)";
    log(`FAIL -- FULL tier: recall did not return a recalled checkpoint (${why}).`);
    return { code: EXIT_FAIL, rebooted: handle2 };
  }
  if (recall.blobId !== close.blobId) {
    log(
      `FAIL -- FULL tier: recall resolved blobId ${recall.blobId} != stored ${close.blobId}. ` +
        "The index did not resolve the blob we just stored.",
    );
    return { code: EXIT_FAIL, rebooted: handle2 };
  }
  log(
    `PASS -- recall resolved the SAME blob ${recall.blobId} via the index and read it back ` +
      "(through a freshly-booted runtime).",
  );

  // CONTINUE from the RECALLED summary (not a hand-supplied one) on the rebooted handle.
  log("--- continue: respond({ resumedSummary: recalled }) must continue from the fact ---");
  const continued = await continueFromSummary(handle2.runtime, session2Room, recall.summary);
  if (!continued) {
    return { code: EXIT_FAIL, rebooted: handle2 };
  }

  log("");
  log("E2E: PASS (FULL) -- memory survived across sessions: closed session 1, REBOOTED, started a");
  log("  new session, recalled the checkpoint from the live index, and the agent CONTINUED from the");
  log(`  session-1 fact ("${SECRET_WORD}") it was never told in session 2. The exit-gate sentence,`);
  log("  exercised live end to end.");
  return { code: EXIT_PASS, rebooted: handle2 };
}

async function main(): Promise<void> {
  log("=== A3 TASK 6: EXIT-GATE PROOF — memory survives across sessions ===");

  loadDotEnv();

  // Detect a REAL Groq key BEFORE injecting the placeholder; the model halves (summarize +
  // continue) only run with a genuine key.
  const hasRealGroqKey = (process.env.GROQ_API_KEY ?? "").trim().length > 0;
  if (!hasRealGroqKey) {
    process.env.GROQ_API_KEY = PLACEHOLDER_GROQ_KEY;
  }

  const config = loadAgentConfig();
  const hasFundedSigner = config.walrusSignerKey !== undefined; // presence only; never logged

  // --- Tier SELECTION (logged up front so the reader knows what THIS run proves). ----
  const tier = !hasRealGroqKey ? "NO-KEY" : hasFundedSigner ? "FULL" : "NO-WALLET";
  log(`TIER SELECTED: ${tier}`);
  log(
    `  inputs: GROQ_API_KEY ${hasRealGroqKey ? "present" : "absent"}, ` +
      `WALRUS_SIGNER_KEY ${hasFundedSigner ? "present" : "absent"} (presence only; secrets never logged).`,
  );

  // TIER NO-KEY: SKIP cleanly. Still run the model-free structural assertion so a no-key
  // run is not a total no-op. Exit 0.
  if (tier === "NO-KEY") {
    const structuralOk = proveStructuralInject();
    log("");
    if (!structuralOk) {
      log("E2E: FAIL -- the model-free structural inject assertion failed.");
      process.exitCode = EXIT_FAIL;
      return;
    }
    log(
      "E2E: SKIP (NO-KEY) -- the exit gate needs the model to summarize + continue. " +
        "Structural inject proven (recalled summary renders into the real prompt).",
    );
    log(
      "  Set a real GROQ_API_KEY in apps/agent/.env to run the NO-WALLET tier (gate proven " +
        "except the live store), and add a funded WALRUS_SIGNER_KEY to run the FULL tier.",
    );
    process.exitCode = EXIT_SKIP;
    return;
  }

  // The model tiers need a booted runtime.
  const runToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let handle: AgentRuntimeHandle;
  try {
    handle = await createAgentRuntime(config);
  } catch (err) {
    log("FAIL -- runtime boot failed");
    log(errorDetail(err));
    log("E2E: FAIL -- boot");
    process.exitCode = EXIT_FAIL;
    return;
  }

  // The FULL tier reboots and returns the second handle so we stop the right one.
  let liveHandle: AgentRuntimeHandle = handle;
  try {
    if (tier === "FULL") {
      const { code, rebooted } = await runFullTier(config, handle, runToken);
      if (rebooted !== undefined) liveHandle = rebooted; // handle was already stopped on reboot
      process.exitCode = code;
    } else {
      // TIER NO-WALLET
      process.exitCode = await runNoWalletTier(handle, runToken);
    }
  } catch (err) {
    log("FAIL -- unexpected error during the e2e proof");
    log(errorDetail(err));
    log("E2E: FAIL -- unexpected");
    process.exitCode = EXIT_FAIL;
  } finally {
    await liveHandle.stop();
  }
}

main().catch((err) => {
  console.error("E2E: FAIL -- unexpected error");
  console.error(errorDetail(err));
  process.exitCode = EXIT_FAIL;
});
