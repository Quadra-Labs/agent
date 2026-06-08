// Demo entry point. Boots everything a teammate needs from a single Groq key:
//   1. load config + .env, boot the ElizaOS runtime (SQLite tier + Groq LLM),
//   2. require a LIVE Walrus testnet (assertReachable) -- no fallback, exit if down,
//   3. ensure the fake job templates exist on Walrus (reuse cached blobId or seed),
//   4. print a banner explaining what the demo shows, then start the REPL.
//
// On any fatal startup error we print a clear message and exit non-zero WITHOUT
// starting the REPL.

import { loadConfig } from "./config.js";
import { createDemoRuntime, type DemoRuntime } from "./runtime.js";
import { assertReachable, WalrusHttpError, type WalrusHttpConfig } from "./walrusHttp.js";
import {
  seedTemplates,
  loadTemplates,
  renderTemplatesForPrompt,
  DEMO_TEMPLATES,
  type JobTemplate,
} from "./templates.js";
import { loadState, saveState } from "./state.js";
import { runRepl } from "./repl.js";

// tsx does not auto-load demo/.env; use Node's built-in loader (missing is fine).
function loadDotEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader(".env");
  } catch {
    // No .env file -- rely on whatever is already in the environment.
  }
}

/**
 * Ensure templates are on Walrus and return both the blobId and the loaded set.
 * Tries the cached blobId first; if that read fails (e.g. the storage window
 * expired) it re-seeds and persists the new id. With no cached id, it seeds.
 */
async function ensureTemplates(
  walrusCfg: WalrusHttpConfig,
): Promise<{ blobId: string; templates: JobTemplate[] }> {
  const state = await loadState();

  if (state.templatesBlobId) {
    try {
      const templates = await loadTemplates(walrusCfg, state.templatesBlobId);
      return { blobId: state.templatesBlobId, templates };
    } catch {
      console.log(
        "Cached templates blob was unreadable (likely expired); re-seeding on Walrus...",
      );
    }
  }

  const { blobId } = await seedTemplates(walrusCfg, DEMO_TEMPLATES);
  await saveState({ ...state, templatesBlobId: blobId });
  const templates = await loadTemplates(walrusCfg, blobId);
  return { blobId, templates };
}

function printBanner(templatesBlobId: string): void {
  const lines = [
    "===========================================================",
    " Walrus Agent Demo -- a runnable slice of the agent framework",
    "===========================================================",
    "What this shows:",
    "  - Chat with the agent in this terminal.",
    "  - Chat persists to a local SQLite-style DB (see it with /history).",
    "  - /close condenses the session into a checkpoint written to MemWal",
    "    on the Walrus testnet (plain, no Seal in the demo).",
    "  - /resume recalls that checkpoint and the agent continues from it.",
    "  - Describe a prediction/finance job and the agent matches a job type,",
    "    confirms it, and collects each parameter conversationally.",
    "  - It stops at a confirmed, parameter-complete job intent: the full",
    "    system would hand off to the Intake Engine here (no oracle/payment).",
    "",
    `Job templates are stored on Walrus at blobId: ${templatesBlobId}`,
    "Type /help for commands. Type /exit to quit.",
    "===========================================================",
    "",
  ];
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  loadDotEnv();

  // Config (throws a clear message if GROQ_API_KEY is missing).
  const config = loadConfig();
  const walrusCfg: WalrusHttpConfig = {
    publisherUrl: config.walrusPublisherUrl,
    aggregatorUrl: config.walrusAggregatorUrl,
  };

  // Boot the runtime BEFORE the Walrus check so a config/boot problem surfaces
  // first; tear it down on any later startup failure.
  let demo: DemoRuntime;
  try {
    demo = await createDemoRuntime(config);
  } catch (err) {
    console.error(
      `Failed to start the agent runtime: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    // Live Walrus is mandatory. No fallback: if it is down, do not start the REPL.
    try {
      await assertReachable(walrusCfg);
    } catch (err) {
      const detail = err instanceof WalrusHttpError ? err.message : String(err);
      console.error(`Walrus testnet is not reachable. The demo requires it.\n  ${detail}`);
      process.exitCode = 1;
      return;
    }

    const { blobId, templates } = await ensureTemplates(walrusCfg);
    const templatesText = renderTemplatesForPrompt(templates);

    printBanner(blobId);

    await runRepl({
      runtime: demo.runtime,
      walrusCfg,
      templatesText,
      stop: demo.stop,
    });
  } catch (err) {
    console.error(
      `Startup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    await demo.stop();
  }
}

main().catch((err) => {
  console.error("Fatal error:");
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
