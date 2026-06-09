// chatProof.ts — A3 Task 3 deliverable: PROVE within-session chat memory.
//
// "Done" definition (the ONLY bar), proven here in one room within one session:
//   (P) PERSIST + ORDER: two user turns are written to the runtime's local DB and
//       listTurns(runtime, roomId) reads them back OLDEST-first. This half needs
//       NO model and runs ALWAYS.
//   (R) RECALL-INTO-PROMPT: driving TWO turns through respond(), the recent-history
//       window passed to the model on turn 2 CONTAINS turn 1's user text, and both
//       turns plus both replies end up persisted (4 memories), oldest-first. This
//       half needs the LLM, so it runs ONLY when a real GROQ_API_KEY is present.
//
// If GROQ_API_KEY is absent we SKIP the model half cleanly (clear message,
// non-failure exit) -- mirroring Task 2's roundtrip SKIP -- but STILL prove (P),
// which needs no model. With a real key we prove the full loop including
// recall-into-prompt.
//
// SCOPE: within-session persistence + recent-history recall ONLY (Task 3). No
// checkpoint writer, summarization, cross-session recall, or MemWal (Tasks 4-6).
// The Groq key is NEVER logged.

import { loadAgentConfig } from "./config.js";
import { createAgentRuntime, type AgentRuntimeHandle } from "./runtime.js";
import { saveTurn, listTurns, type ChatTurn } from "./chatMemory.js";
import { respond } from "./chat.js";

// Placeholder so config + boot proceed when no real Groq key is present. The
// PERSIST half never calls the LLM, so the placeholder is harmless there; we
// detect a real key BEFORE applying the placeholder so the RECALL half only runs
// when a genuine key exists.
const PLACEHOLDER_GROQ_KEY = "gsk_chatproof_placeholder_persist_only";

// Exit codes. SKIP is a NON-FAILURE (0): "no Groq key, model half skipped" is not
// an error. PASS is 0; FAIL is 1.
const EXIT_PASS = 0;
const EXIT_SKIP = 0;
const EXIT_FAIL = 1;

function log(line: string): void {
  console.log(line);
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

// Load apps/agent/.env into process.env if present (tsx does not auto-load it).
// A missing file is fine (env may come from the shell). Mirrors boot.ts/roundtrip.
function loadDotEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader(".env");
  } catch {
    // No .env file -- rely on whatever is already in the environment.
  }
}

function summarize(turns: readonly ChatTurn[]): string {
  return turns.map((t, i) => `  [${i}] ${t.role}@${t.createdAt}: ${t.text}`).join("\n");
}

// Assert a turn list is non-decreasing by createdAt (oldest-first). Returns the
// offending index pair, or undefined when correctly ordered.
function firstOutOfOrder(turns: readonly ChatTurn[]): string | undefined {
  for (let i = 1; i < turns.length; i += 1) {
    if (turns[i].createdAt < turns[i - 1].createdAt) return `${i - 1}->${i}`;
  }
  return undefined;
}

// (P) PERSIST + ORDER: write two USER turns directly and read them back
// oldest-first. No model involved. Returns true on pass. The caller passes a
// run-unique roomId so the local DB (durable PGlite, reused across runs) starts
// empty for THIS proof and the exact-count assertion is deterministic.
async function provePersist(handle: AgentRuntimeHandle, roomId: string): Promise<boolean> {
  const runtime = handle.runtime;
  log("--- (P) persist two turns + read back oldest-first (no model) ---");

  const first = "Turn one: my favorite color is teal.";
  const second = "Turn two: and my favorite number is seven.";
  await saveTurn(runtime, { roomId, role: "user", text: first });
  await saveTurn(runtime, { roomId, role: "user", text: second });

  const turns = await listTurns(runtime, roomId);
  log(summarize(turns));

  if (turns.length !== 2) {
    log(`FAIL -- expected 2 turns persisted, got ${turns.length}`);
    return false;
  }
  const disorder = firstOutOfOrder(turns);
  if (disorder !== undefined) {
    log(`FAIL -- turns not oldest-first (createdAt decreases at ${disorder})`);
    return false;
  }
  if (turns[0].text !== first || turns[1].text !== second) {
    log("FAIL -- read-back order does not match write order (oldest-first expected)");
    return false;
  }
  log("PASS -- (P) both turns persisted and read back OLDEST-first");
  return true;
}

// (R) RECALL-INTO-PROMPT: drive two real turns through respond() and assert turn
// 1's text is present in the prompt the model receives on turn 2, and that all
// four memories (2 user + 2 agent) persisted oldest-first. Needs the LLM. The
// caller passes a run-unique roomId so this proof starts from an empty room.
async function proveRecall(handle: AgentRuntimeHandle, roomId: string): Promise<boolean> {
  const runtime = handle.runtime;
  const user = "proof-user";
  log("--- (R) two real turns through respond(); recall into the turn-2 prompt ---");

  const turn1Text = "Remember this: the secret word is moonquake.";
  const reply1 = await respond(runtime, { roomId, user, text: turn1Text });
  log(`turn 1 reply (len=${reply1.length}) received`);

  // Capture the EXACT prompt the model receives on turn 2.
  let turn2Prompt = "";
  const turn2Text = "What was the secret word I told you?";
  const reply2 = await respond(runtime, {
    roomId,
    user,
    text: turn2Text,
    onPrompt: (p) => {
      turn2Prompt = p;
    },
  });
  log(`turn 2 reply (len=${reply2.length}) received`);

  if (!turn2Prompt.includes(turn1Text)) {
    log("FAIL -- turn-2 prompt does NOT contain turn 1's text (no recall into prompt)");
    return false;
  }
  log("PASS -- (R) turn-2 prompt CONTAINS turn 1's text (recent history injected)");

  const turns = await listTurns(runtime, roomId);
  log(summarize(turns));
  if (turns.length !== 4) {
    log(`FAIL -- expected 4 memories (2 user + 2 agent), got ${turns.length}`);
    return false;
  }
  const disorder = firstOutOfOrder(turns);
  if (disorder !== undefined) {
    log(`FAIL -- conversation not oldest-first (createdAt decreases at ${disorder})`);
    return false;
  }
  if (turns[0].text !== turn1Text || turns[0].role !== "user") {
    log("FAIL -- oldest turn is not the first user message");
    return false;
  }
  if (turns[2].text !== turn2Text || turns[2].role !== "user") {
    log("FAIL -- third memory is not the second user message");
    return false;
  }
  log("PASS -- (R) full conversation persisted oldest-first (4 memories)");
  return true;
}

async function main(): Promise<void> {
  log("=== A3 TASK 3: within-session chat memory (live chat -> SQLite) ===");

  loadDotEnv();

  // Detect a REAL Groq key BEFORE we inject the placeholder. Only with a real key
  // do we run the model-dependent RECALL half.
  const hasRealGroqKey = (process.env.GROQ_API_KEY ?? "").trim().length > 0;
  if (!hasRealGroqKey) {
    process.env.GROQ_API_KEY = PLACEHOLDER_GROQ_KEY;
  }

  const config = loadAgentConfig();

  // Run-unique room ids. The local DB (PGlite) is durable and reused across runs,
  // so a fixed room would accumulate turns and break the exact-count assertions.
  // A per-run token gives each proof an empty room to start from.
  const runToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const persistRoom = `a3-task3-persist-${runToken}`;
  const recallRoom = `a3-task3-recall-${runToken}`;

  let handle: AgentRuntimeHandle;
  try {
    handle = await createAgentRuntime(config);
  } catch (err) {
    log("FAIL -- runtime boot failed");
    log(errorDetail(err));
    log("CHATPROOF: FAIL -- boot");
    process.exitCode = EXIT_FAIL;
    return;
  }

  try {
    // (P) always runs -- proves persistence + oldest-first ordering with no model.
    const persistOk = await provePersist(handle, persistRoom);
    if (!persistOk) {
      log("CHATPROOF: FAIL -- persistence/order half failed");
      process.exitCode = EXIT_FAIL;
      return;
    }

    if (!hasRealGroqKey) {
      log(
        "SKIP -- GROQ_API_KEY not set; skipping the model-dependent recall half. " +
          "Set a real key in apps/agent/.env to prove recall-into-prompt.",
      );
      log("CHATPROOF: SKIP (model half) -- persistence proven, recall skipped (clean, non-failure)");
      process.exitCode = EXIT_SKIP;
      return;
    }

    // (R) runs only with a real key -- proves recall-into-prompt + full ordering.
    const recallOk = await proveRecall(handle, recallRoom);
    if (!recallOk) {
      log("CHATPROOF: FAIL -- recall-into-prompt half failed");
      process.exitCode = EXIT_FAIL;
      return;
    }

    log("CHATPROOF: PASS -- persistence + oldest-first + recall-into-prompt all proven");
    process.exitCode = EXIT_PASS;
  } catch (err) {
    log("FAIL -- unexpected error during chat proof");
    log(errorDetail(err));
    log("CHATPROOF: FAIL -- unexpected");
    process.exitCode = EXIT_FAIL;
  } finally {
    await handle.stop();
  }
}

main().catch((err) => {
  console.error("CHATPROOF: FAIL -- unexpected error");
  console.error(errorDetail(err));
  process.exitCode = EXIT_FAIL;
});
