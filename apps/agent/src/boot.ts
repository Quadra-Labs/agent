// boot.ts — A3 Task 1 deliverable: the boot smoke check.
//
// "Done" definition (the ONLY bar): the process boots with no migration/FK
// errors, and at startup runtime.getService("walrus") AND
// runtime.getService("memwal") BOTH return a live (non-undefined) service
// instance. This script boots the runtime with all four plugins, asserts both
// services are live, then stops cleanly. Prints a labeled PASS/FAIL per check and
// ends with `BOOT: PASS` or `BOOT: FAIL -- <which>`, setting process.exitCode.
//
// Scope: BOOT + SERVICE-RESOLUTION ONLY. It does NOT perform a live Walrus store,
// build chat memory, or exercise checkpoints (Tasks 2-6). The Walrus service is
// asserted live whether or not a signer is configured (a signer-less Walrus is a
// valid read-only service; store() would later return config_error).

import { loadAgentConfig } from "./config.js";
import { createAgentRuntime, type AgentRuntimeHandle } from "./runtime.js";

// Placeholder used ONLY to satisfy config + boot when no Groq key is present. This
// task never calls the LLM, so a placeholder is harmless: service resolution does
// not depend on Groq. A real key is NOT required to prove "done".
const PLACEHOLDER_GROQ_KEY = "gsk_boot_placeholder_services_only";

function pass(label: string): void {
  console.log(`PASS -- ${label}`);
}

function failLine(label: string, detail?: string): void {
  console.log(`FAIL -- ${label}${detail ? `: ${detail}` : ""}`);
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

// Load apps/agent/.env into process.env if present (tsx does not auto-load it).
// Uses Node's built-in loader; a missing file is fine (env may come from shell).
function loadDotEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader(".env");
  } catch {
    // No .env file -- rely on whatever is already in the environment.
  }
}

async function main(): Promise<void> {
  console.log("=== AGENT BOOT SMOKE (all four plugins) ===");

  loadDotEnv();

  if ((process.env.GROQ_API_KEY ?? "").trim().length === 0) {
    // Boot does not call the LLM here; a placeholder lets config + boot proceed.
    process.env.GROQ_API_KEY = PLACEHOLDER_GROQ_KEY;
  }

  const config = loadAgentConfig();

  // (a) Runtime boots with no migration/FK errors.
  let handle: AgentRuntimeHandle;
  try {
    handle = await createAgentRuntime(config);
    pass("(a) runtime boots + DB migrations run (no migration/FK errors)");
  } catch (err) {
    failLine("(a) runtime boots", errorDetail(err));
    console.log("BOOT: FAIL -- (a) runtime boot");
    process.exitCode = 1;
    return;
  }

  try {
    // (b) Walrus service resolves live.
    const walrus = handle.runtime.getService("walrus");
    if (walrus === undefined || walrus === null) {
      failLine('(b) getService("walrus") is live', "service is undefined");
      console.log("BOOT: FAIL -- walrus service not live");
      process.exitCode = 1;
      return;
    }
    pass('(b) getService("walrus") returns a live service instance');

    // (c) MemWal service resolves live (and could resolve Walrus underneath it).
    const memwal = handle.runtime.getService("memwal");
    if (memwal === undefined || memwal === null) {
      failLine('(c) getService("memwal") is live', "service is undefined");
      console.log("BOOT: FAIL -- memwal service not live");
      process.exitCode = 1;
      return;
    }
    pass('(c) getService("memwal") returns a live service instance');

    console.log("BOOT: PASS");
    process.exitCode = 0;
  } finally {
    await handle.stop();
  }
}

main().catch((err) => {
  console.error("BOOT: FAIL -- unexpected error");
  console.error(errorDetail(err));
  process.exitCode = 1;
});
