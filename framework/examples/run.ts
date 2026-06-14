// run.ts — the BRIDGE that runs the framework `priceRangeAgent` through the app's REAL intake /
// seal / payment loop. It reuses the app's exported `runInteractiveAgent` (so there is no app ->
// framework dependency) and injects a `produce` hook that runs the agent's Pyth `quote_price_range`
// skill to generate the {minPrice, maxPrice} result after payment confirms. The agent's identity
// (character) comes from the framework `defineAgent`. Run: `npm run example:price-range`.

import { fileURLToPath } from "node:url";

import { runInteractiveAgent } from "../../app/src/runtime/runInteractiveAgent.js";
import { parseDurationMs } from "../../app/src/templates/intakeTemplate.js";
import type { ProduceHook } from "../../app/src/jobs/jobResult.js";
import { runSkill, makeSkillContext, makeHttp } from "../src/index.js";
import { priceRangeAgent, quotePriceRange } from "./priceRangeAgent.js";

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

  // One bounded HTTP client shared by every produce call (the skill fetches Pyth through it).
  const http = makeHttp();

  // The result producer: run the framework skill, map its typed output to the job result. The
  // app validates this against the template's output schema before sealing. NEVER throws.
  const produce: ProduceHook = async ({ collected }) => {
    const asset = collected.asset ?? "BTC";
    const lifetimeMs = parseDurationMs(collected.horizon ?? "") ?? 60_000;
    const ctx = makeSkillContext({ http });
    const res = await runSkill(quotePriceRange, { asset, lifetimeMs }, ctx);
    if (!res.ok) {
      return { ok: false, reason: `${res.error.kind}: ${res.error.message}` };
    }
    return { ok: true, result: { minPrice: res.value.minPrice, maxPrice: res.value.maxPrice } };
  };

  await runInteractiveAgent({
    character: priceRangeAgent.character,
    user: parseUser(process.argv.slice(2)),
    produce,
  });
}

main().catch((err) => {
  console.error("example:price-range crashed:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
