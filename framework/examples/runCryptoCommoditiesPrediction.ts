// runCryptoCommoditiesPrediction.ts — the BRIDGE that runs the framework
// `cryptoCommoditiesPredictionAgent` through the app's REAL intake / seal / payment loop AND the
// free competition loop. It injects an LLM-DRIVEN `produce` hook (makeSkillProducer): after payment
// confirms, the MODEL decides which of the agent's declared skills to call (here:
// forecast_crypto_probability) to produce { probability }, mapping the collected job params
// (market_id / target_ts) to the skill's input itself. Run: `npm run example:crypto-prediction`.

import { fileURLToPath } from "node:url";

import { runInteractiveAgent } from "../../app/src/runtime/runInteractiveAgent.js";
import { makeSkillProducer } from "../src/index.js";
import { cryptoCommoditiesPredictionAgent } from "./cryptoCommoditiesPredictionAgent.js";

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
    character: cryptoCommoditiesPredictionAgent.character,
    user: parseUser(process.argv.slice(2)),
    produce: makeSkillProducer(cryptoCommoditiesPredictionAgent.skills),
  });
}

main().catch((err) => {
  console.error(
    "example:crypto-prediction crashed:",
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exit(1);
});
