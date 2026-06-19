// run.ts — the BRIDGE that runs the framework `priceRangeAgent` through the app's REAL intake /
// seal / payment loop. It reuses the app's exported `runInteractiveAgent` (so there is no app ->
// framework dependency) and injects an LLM-DRIVEN `produce` hook (makeSkillProducer): after payment
// confirms, the MODEL decides which of the agent's declared skills to call to produce the
// {minPrice, maxPrice} result. The agent's identity (character) + its skill manifest both come from
// the framework `defineAgent`. Run: `npm run example:price-range`.

import { fileURLToPath } from "node:url";

import { runInteractiveAgent } from "../../app/src/runtime/runInteractiveAgent.js";
import { makeSkillProducer } from "../src/index.js";
import { priceRangeAgent } from "./priceRangeAgent.js";

// Load the app's .env (this script runs from agent/framework, so the app .env is two dirs up).
function loadAppEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader(fileURLToPath(new URL("../../app/.env", import.meta.url)));
  } catch {
    // No .env -- rely on whatever is already in the environment.
  }
}

function parseUser(argv: readonly string[]): string {
  const i = argv.indexOf("--user");
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : "demo-user";
}

async function main(): Promise<void> {
  loadAppEnv();

  await runInteractiveAgent({
    character: priceRangeAgent.character,
    user: parseUser(process.argv.slice(2)),
    // The model picks which declared skill to run (here: quote_price_range) to produce the result.
    produce: makeSkillProducer(priceRangeAgent.skills),
  });
}

main().catch((err) => {
  console.error("example:price-range crashed:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
