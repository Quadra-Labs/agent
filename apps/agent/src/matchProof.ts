// matchProof.ts — A4 Task 6 deliverable: the A4 EXIT-GATE proof.
//
// Exit gate: a single scripted run where the user describes a job, the agent CONFIRMS
// the matched job in natural language (no leak tokens), COLLECTS every parameter across
// turns, and on completion the framework CONSTRUCTS the four-field Intake notification
// (never signed/sent). This run IS the exit gate.
//
// It strings the REAL A4 pieces together end to end through the booted runtime —
// nothing is re-implemented:
//   - seed + load a templates blob via templates.ts (LIVE Walrus when a funded signer
//     is present; a NO-WALLET tier uses an in-memory template set so match/confirm/
//     collect/notification still run through the model)
//   - drive the conversation via the REAL chat.ts respond({ templatesText }) — the
//     same template-provider seam the app uses
//   - on completion build the stub notification via intakeNotification.ts completeIntake
//     and assert its four-field shape
//
// HONEST TIERS (mirrors e2eProof.ts; no faked gate). The live Walrus store needs a
// funded testnet signer; the model halves (match/confirm/collect/extract) need a real
// Groq key. We run the HIGHEST tier reachable and exit 0 on it:
//
//   TIER FULL      (real Groq key AND funded signer): seed templates to a LIVE Walrus
//                  blob, load them back, then run the full match -> collect -> notify
//                  conversation. Prints A4: PASS (FULL).
//
//   TIER NO-WALLET (real Groq key, NO funded signer): the live Walrus store is
//                  unreachable without gas, so seed surfaces config_error (asserted, no
//                  false success); the match/collect/notify conversation still runs in
//                  full against an IN-MEMORY template set. Prints A4: PASS (NO-WALLET).
//
//   TIER NO-KEY    (no Groq key): SKIP the model halves cleanly. Still runs the
//                  model-free STRUCTURAL assertions (renderTemplates injects the block +
//                  rules ahead of history; absent -> byte-identical to A3; the pure
//                  buildIntakeNotification yields the four fields). Exit 0.
//
// The tier SELECTION is logged up front. No template AUTHORING (agents only CONFORM),
// no signing/sending of the notification, no scoring/registration. The Groq key and the
// signer secret are NEVER logged.

import type { IAgentRuntime } from "@elizaos/core";

import { loadAgentConfig, type AgentConfig } from "./config.js";
import { createAgentRuntime, type AgentRuntimeHandle } from "./runtime.js";
import { AGENT_NAME } from "./runtime.js";
import { respond, buildChatPrompt } from "./chat.js";
import { listTurns } from "./chatMemory.js";
import {
  DEFAULT_TEMPLATES,
  seedTemplates,
  loadTemplates,
  renderTemplatesForPrompt,
  parseTemplates,
  type JobTemplate,
} from "./templates.js";
import {
  buildIntakeNotification,
  completeIntake,
  type IntakeNotification,
} from "./intakeNotification.js";

// Placeholder so config + boot proceed without a real Groq key (the NO-KEY tier still
// boots to run the model-free structural assertions). The model halves only run when a
// REAL key is detected BEFORE this placeholder is applied.
const PLACEHOLDER_GROQ_KEY = "gsk_matchproof_placeholder_structural_only";

const EXIT_PASS = 0;
const EXIT_SKIP = 0; // a clean tier downgrade is a NON-FAILURE
const EXIT_FAIL = 1;

// A stable identity for the gate. The user-wallet / agent-id are PROVISIONAL stubs
// (the notification's cross-workstream identity interfaces are not yet locked).
const GATE_USER = "a4-gate-user-wallet";
const GATE_AGENT = AGENT_NAME; // matches runtime.AGENT_NAME

// The single template the gate drives. We pick the BTC price-range job and script a
// user who describes exactly it, so the match is unambiguous and both params are
// collectable in a bounded number of turns.
const GATE_TEMPLATE: JobTemplate =
  DEFAULT_TEMPLATES.find((t) => t.category_id === "btc-price-guess") ?? DEFAULT_TEMPLATES[0];

// Leak tokens the confirmation/collection MUST NOT contain (Task 3 leak guard). The
// raw param names + the word "template" + a JSON brace are the signal of a leak.
const LEAK_TOKENS: readonly string[] = [
  "template",
  "category_id",
  "job_template",
  "minPrice",
  "maxPrice",
  "{",
  "}",
];

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

// Does a reply leak any internal token? Case-insensitive substring scan. A clean
// confirmation/collection is ordinary conversation with none of these present.
function leaksInternals(reply: string): string | undefined {
  const lower = reply.toLowerCase();
  return LEAK_TOKENS.find((tok) => lower.includes(tok.toLowerCase()));
}

// ===========================================================================
// MODEL-FREE STRUCTURAL ASSERTIONS (NO key, NO wallet). Always run.
//   (S1) renderTemplates injects the readable block + behavior rules ahead of the
//        history; ABSENT templatesText -> prompt byte-identical to A3.
//   (S2) the pure buildIntakeNotification yields the four fields with the REAL
//        job_template and a stub job_id derived from category_id.
// ===========================================================================
function proveStructural(): boolean {
  log("--- structural (model-free): template inject + pure notification builder ---");
  const templatesText = renderTemplatesForPrompt([GATE_TEMPLATE]);
  const history = [
    { role: "user" as const, text: "hi", createdAt: 1 },
    { role: "agent" as const, text: "hello", createdAt: 2 },
  ];

  // (S1a) With templatesText the block + rules render, ahead of the history.
  const withTemplates = buildChatPrompt(history, undefined, templatesText);
  if (!withTemplates.includes(templatesText.trim())) {
    log("FAIL -- (S1) the readable templates block is not present in the built prompt");
    return false;
  }
  if (!withTemplates.includes("How to behave for job intake:")) {
    log("FAIL -- (S1) the job-intake behavior rules are not present with templates");
    return false;
  }
  const blockAt = withTemplates.indexOf("Job types you can handle");
  const historyAt = withTemplates.indexOf("Conversation so far:");
  if (blockAt < 0 || historyAt < 0 || blockAt >= historyAt) {
    log("FAIL -- (S1) the templates block is not positioned BEFORE the recent history");
    return false;
  }

  // (S1b) ABSENT templatesText (and resumedSummary) -> byte-identical to A3.
  const baseline = buildChatPrompt(history);
  const absent = buildChatPrompt(history, undefined, undefined);
  if (absent !== baseline) {
    log("FAIL -- (S1) absent-templates prompt differs from the A3 baseline");
    return false;
  }
  if (
    absent.includes("Job types you can handle") ||
    absent.includes("How to behave for job intake:")
  ) {
    log("FAIL -- (S1) absent-templates prompt leaked a job-intake section");
    return false;
  }
  log("PASS -- (S1) templates inject block + rules ahead of history; absent -> byte-identical to A3");

  // (S2) Pure builder: four fields, REAL job_template, stub job_id from category_id.
  const note: IntakeNotification = buildIntakeNotification({
    userWallet: GATE_USER,
    template: GATE_TEMPLATE,
    agentId: GATE_AGENT,
    idSuffix: "fixed-suffix",
  });
  const fourFieldsPresent =
    typeof note.user_wallet === "string" &&
    note.job_template !== undefined &&
    typeof note.job_id === "string" &&
    typeof note.agent_id === "string";
  if (!fourFieldsPresent) {
    log("FAIL -- (S2) buildIntakeNotification did not populate all four fields");
    return false;
  }
  if (note.user_wallet !== GATE_USER || note.agent_id !== GATE_AGENT) {
    log("FAIL -- (S2) the provisional user_wallet/agent_id stubs did not pass through");
    return false;
  }
  if (note.job_template !== GATE_TEMPLATE.job_template) {
    log("FAIL -- (S2) job_template must be the matched template's REAL { output, lifetime }");
    return false;
  }
  if (note.job_id !== `job-${GATE_TEMPLATE.category_id}-fixed-suffix`) {
    log("FAIL -- (S2) job_id stub must be job-<category_id>-<suffix>");
    return false;
  }
  log("PASS -- (S2) pure buildIntakeNotification: four fields, REAL job_template, stub job_id");

  // (S3) parseTemplates STRUCTURAL validation: the framework consumes untrusted
  // Walrus blobs, so a JSON array of MALFORMED objects must map to invalid_templates,
  // NOT a deceptive ok:true (which would later throw past the typed boundary). A
  // well-formed array must still parse ok:true.
  const enc = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
  const malformed = parseTemplates("blob-malformed", enc([{}]));
  if (malformed.ok || malformed.kind !== "invalid_templates") {
    log("FAIL -- (S3) a malformed-array blob ([{}]) must return invalid_templates, not ok:true");
    return false;
  }
  const notArray = parseTemplates("blob-not-array", enc({ not: "an array" }));
  if (notArray.ok || notArray.kind !== "invalid_templates") {
    log("FAIL -- (S3) a non-array blob must return invalid_templates");
    return false;
  }
  const wellFormed = parseTemplates("blob-ok", enc(DEFAULT_TEMPLATES));
  if (!wellFormed.ok || wellFormed.templates.length !== DEFAULT_TEMPLATES.length) {
    log("FAIL -- (S3) a well-formed templates array must still parse ok:true");
    return false;
  }
  log("PASS -- (S3) parseTemplates rejects malformed/non-array blobs as invalid_templates");
  return true;
}

// ===========================================================================
// The LIVE conversation half (needs a real Groq key). Given a templatesText, drive a
// scripted user through respond({ templatesText }): describe the job -> confirm match
// -> collect EVERY parameter across turns -> assert no leak tokens at any turn. Then
// build the notification via completeIntake and assert the four-field shape. Returns
// the constructed notification on success, or undefined on failure.
// ===========================================================================
async function runConversation(
  runtime: IAgentRuntime,
  roomId: string,
  templatesText: string,
): Promise<IntakeNotification | undefined> {
  // A scripted user that describes the BTC price-range job, then answers each param
  // question. The agent must confirm the match, then collect `asset` and `horizon`.
  const userLines: readonly string[] = [
    "I want you to predict the price range of a cryptocurrency for me.",
    "Yes, that's right -- please go ahead.",
    "Let's do Bitcoin.",
    "Predict the range over the next 24 hours.",
  ];

  for (const [index, text] of userLines.entries()) {
    let injectedPrompt = "";
    const reply = await respond(runtime, {
      roomId,
      user: GATE_USER,
      text,
      templatesText,
      onPrompt: (p) => {
        injectedPrompt = p;
      },
    });

    // The templates block must be present in the REAL prompt the model received (the
    // Task 2 inject seam, live), on every turn.
    if (!injectedPrompt.includes(templatesText.trim())) {
      log(`FAIL -- turn ${index + 1}: templatesText was NOT injected into the real prompt`);
      return undefined;
    }
    // No leak tokens in any agent reply (Task 3 leak guard).
    const leak = leaksInternals(reply);
    if (leak !== undefined) {
      log(`FAIL -- turn ${index + 1}: agent reply leaked an internal token ("${leak}")`);
      log(`  reply was: ${reply}`);
      return undefined;
    }
    log(`  turn ${index + 1} ok (len=${reply.length}, no leak tokens)`);
  }

  // The FIRST agent reply should read as a confirmation question. We assert softly:
  // it must contain a question mark (confirming the match in natural language) and
  // already passed the leak guard above.
  const turns = await listTurns(runtime, roomId);
  const firstAgentReply = turns.find((t) => t.role === "agent")?.text ?? "";
  if (!firstAgentReply.includes("?")) {
    log("FAIL -- the agent's first reply did not ask a confirmation question");
    return undefined;
  }
  log("PASS -- agent confirmed the match in natural language (no leak tokens)");

  // On completion: extract the collected values from the transcript via ONE structured
  // model call and CONSTRUCT the notification (logged, never signed/sent).
  log("--- on completion: completeIntake extracts values + CONSTRUCTS the notification ---");
  const { notification, collected } = await completeIntake(runtime, {
    template: GATE_TEMPLATE,
    turns,
    userWallet: GATE_USER,
    agentId: GATE_AGENT,
  });
  log(`  extracted collected params: ${JSON.stringify(collected)}`);

  // Assert EVERY template parameter was collected (the user answered each one across
  // turns; the transcript IS the cross-turn state).
  const missing = Object.keys(GATE_TEMPLATE.params).filter(
    (name) => (collected[name] ?? "").trim().length === 0,
  );
  if (missing.length > 0) {
    log(`FAIL -- not every parameter was collected; still missing: ${missing.join(", ")}`);
    return undefined;
  }
  log(`PASS -- every parameter collected across turns: ${Object.keys(GATE_TEMPLATE.params).join(", ")}`);

  return notification;
}

// Assert the constructed notification has the four fields populated with the REAL
// job_template and the provisional stubs. Shared by the FULL and NO-WALLET tiers.
function assertNotificationShape(note: IntakeNotification): boolean {
  log(`  notification: ${JSON.stringify(note)}`);
  if (
    typeof note.user_wallet !== "string" ||
    note.job_template === undefined ||
    typeof note.job_id !== "string" ||
    typeof note.agent_id !== "string"
  ) {
    log("FAIL -- constructed notification is missing one of its four fields");
    return false;
  }
  if (note.job_template !== GATE_TEMPLATE.job_template) {
    log("FAIL -- notification job_template is not the matched template's REAL { output, lifetime }");
    return false;
  }
  if (!note.job_id.startsWith(`job-${GATE_TEMPLATE.category_id}-`)) {
    log("FAIL -- notification job_id stub is not job-<category_id>-...");
    return false;
  }
  log("PASS -- constructed notification has all four fields (REAL job_template, stub identity/job_id)");
  return true;
}

// ===========================================================================
// TIER FULL: seed templates to a LIVE Walrus blob, load them back, run the full
// match -> collect -> notify conversation.
// ===========================================================================
async function runFullTier(handle: AgentRuntimeHandle, runToken: string): Promise<number> {
  const runtime = handle.runtime;

  log("--- seed templates to a LIVE Walrus blob (SDK service) ---");
  const seeded = await seedTemplates(runtime);
  if (!seeded.ok) {
    log(
      `FAIL -- FULL tier: seedTemplates returned a typed error (${seeded.kind}: ${seeded.message}). ` +
        "The funded signer did not complete the live store.",
    );
    return EXIT_FAIL;
  }
  log(`PASS -- templates stored on Walrus: blob ${seeded.blobId}`);

  log("--- load templates back from the LIVE Walrus blob ---");
  const loaded = await loadTemplates(runtime, seeded.blobId);
  if (!loaded.ok) {
    log(`FAIL -- FULL tier: loadTemplates returned a typed error (${loaded.kind}: ${loaded.message}).`);
    return EXIT_FAIL;
  }
  if (loaded.templates.length !== DEFAULT_TEMPLATES.length) {
    log(
      `FAIL -- FULL tier: round-tripped ${loaded.templates.length} templates, ` +
        `expected ${DEFAULT_TEMPLATES.length}.`,
    );
    return EXIT_FAIL;
  }
  log(`PASS -- templates round-tripped through Walrus (${loaded.templates.length} templates)`);

  const templatesText = renderTemplatesForPrompt(loaded.templates);
  const note = await runConversation(runtime, `a4-full-${runToken}`, templatesText);
  if (note === undefined) return EXIT_FAIL;
  if (!assertNotificationShape(note)) return EXIT_FAIL;

  log("");
  log("A4: PASS (FULL) -- templates round-tripped through LIVE Walrus, the agent confirmed the");
  log("  match and collected every parameter across turns with no leak tokens, and the framework");
  log("  CONSTRUCTED the four-field Intake notification (logged, never signed/sent).");
  return EXIT_PASS;
}

// ===========================================================================
// TIER NO-WALLET: the live store is unreachable without gas. Assert seed surfaces a
// typed error (no false success), then run the full conversation against an IN-MEMORY
// template set so match/collect/notify are still proven live.
// ===========================================================================
async function runNoWalletTier(handle: AgentRuntimeHandle, runToken: string): Promise<number> {
  const runtime = handle.runtime;

  log("--- seed templates (NO funded signer): expect a typed config_error, no false success ---");
  const seeded = await seedTemplates(runtime);
  if (seeded.ok) {
    log(
      "FAIL -- NO-WALLET expected seedTemplates to surface a typed error (no funded signer), " +
        "got ok:true. A funded key would make this the FULL tier instead.",
    );
    return EXIT_FAIL;
  }
  if (seeded.kind !== "config_error") {
    log(
      `FAIL -- NO-WALLET expected kind:"config_error" (signer-less Walrus), got "${seeded.kind}". ` +
        "The live store is not proven unreachable by a different error.",
    );
    return EXIT_FAIL;
  }
  log(`PASS -- seedTemplates surfaced config_error (errorName=${seeded.errorName}); no false success`);

  // The live Walrus blob is unreachable without gas, so drive the conversation against
  // an IN-MEMORY template set (the SAME defaults a successful seed would have stored).
  // match/confirm/collect/notify are fully exercised live; only the Walrus round-trip
  // is the one unproven link.
  const templatesText = renderTemplatesForPrompt(DEFAULT_TEMPLATES);
  const note = await runConversation(runtime, `a4-no-wallet-${runToken}`, templatesText);
  if (note === undefined) return EXIT_FAIL;
  if (!assertNotificationShape(note)) return EXIT_FAIL;

  log("");
  log(
    "A4: PASS (NO-WALLET) -- match/confirm/collect/notify proven LIVE against an in-memory template " +
      "set; the agent confirmed the match and collected every parameter across turns with no leak " +
      "tokens, and the framework CONSTRUCTED the four-field notification (logged, never signed/sent).",
  );
  log(
    "  UNPROVEN until a funded WALRUS_SIGNER_KEY is supplied: exactly ONE link -- seeding the " +
      "templates to a durable Walrus blob and loading them back. Supplying a funded key flips this " +
      "run to TIER FULL automatically (no code change).",
  );
  return EXIT_PASS;
}

async function main(): Promise<void> {
  log("=== A4 TASK 6: EXIT-GATE PROOF -- match -> confirm -> collect -> construct Intake notification ===");

  loadDotEnv();

  // Detect a REAL Groq key BEFORE injecting the placeholder; the model halves
  // (confirm/collect/extract) only run with a genuine key.
  const hasRealGroqKey = (process.env.GROQ_API_KEY ?? "").trim().length > 0;
  if (!hasRealGroqKey) {
    process.env.GROQ_API_KEY = PLACEHOLDER_GROQ_KEY;
  }

  const config: AgentConfig = loadAgentConfig();
  const hasFundedSigner = config.walrusSignerKey !== undefined; // presence only; never logged

  // --- Tier SELECTION (logged up front so the reader knows what THIS run proves). ----
  const tier = !hasRealGroqKey ? "NO-KEY" : hasFundedSigner ? "FULL" : "NO-WALLET";
  log(`TIER SELECTED: ${tier}`);
  log(
    `  inputs: GROQ_API_KEY ${hasRealGroqKey ? "present" : "absent"}, ` +
      `WALRUS_SIGNER_KEY ${hasFundedSigner ? "present" : "absent"} (presence only; secrets never logged).`,
  );

  // The model-free structural assertions run in EVERY tier (cheap, always-true seam
  // checks). They are the whole of the NO-KEY tier and a sanity gate for the others.
  const structuralOk = proveStructural();
  if (!structuralOk) {
    log("");
    log("A4: FAIL -- a model-free structural assertion failed (template inject / pure builder).");
    process.exitCode = EXIT_FAIL;
    return;
  }

  // TIER NO-KEY: SKIP the model halves cleanly. Exit 0.
  if (tier === "NO-KEY") {
    log("");
    log(
      "A4: SKIP (NO-KEY) -- the exit gate needs the model to confirm/collect/extract. " +
        "Structural assertions proven (template inject + pure notification builder).",
    );
    log(
      "  Set a real GROQ_API_KEY in apps/agent/.env to run the NO-WALLET tier (full conversation " +
        "against an in-memory template set), and add a funded WALRUS_SIGNER_KEY to run the FULL tier.",
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
    log("A4: FAIL -- boot");
    process.exitCode = EXIT_FAIL;
    return;
  }

  try {
    process.exitCode =
      tier === "FULL"
        ? await runFullTier(handle, runToken)
        : await runNoWalletTier(handle, runToken);
  } catch (err) {
    log("FAIL -- unexpected error during the A4 match proof");
    log(errorDetail(err));
    log("A4: FAIL -- unexpected");
    process.exitCode = EXIT_FAIL;
  } finally {
    await handle.stop();
  }
}

main().catch((err) => {
  console.error("A4: FAIL -- unexpected error");
  console.error(errorDetail(err));
  process.exitCode = EXIT_FAIL;
});
