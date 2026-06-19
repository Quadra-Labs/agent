// runPolymarketResolutionForecaster.ts — the BRIDGE that runs the framework
// `polymarketResolutionForecaster` through the app's REAL intake / seal / payment loop (and the
// free competition loop). It injects an LLM-DRIVEN `produce` hook (makeSkillProducer): after
// payment confirms, the MODEL decides which of the agent's declared skills to call (here:
// call_market_resolution) to produce { outcome }, mapping the collected market_id param to the
// skill's input itself. Run from agent/framework:
//   npx tsx examples/runPolymarketResolutionForecaster.ts --user demo-user

import { fileURLToPath } from "node:url";

import { runInteractiveAgent } from "../../app/src/runtime/runInteractiveAgent.js";
import { makeSkillProducer } from "../src/index.js";
import { polymarketResolutionForecaster } from "./polymarketResolutionForecaster.js";

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
    character: polymarketResolutionForecaster.character,
    user: parseUser(process.argv.slice(2)),
    produce: makeSkillProducer(polymarketResolutionForecaster.skills),
  });
}

main().catch((err) => {
  console.error(
    "polymarket-resolution-forecaster crashed:",
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exit(1);
});
