// runPolymarketPrice.ts — the BRIDGE that runs the framework `polymarketPriceAgent` through the
// app's REAL intake / seal / payment loop AND the free competition loop. It injects an LLM-DRIVEN
// `produce` hook (makeSkillProducer): after payment confirms, the MODEL decides which of the
// agent's declared skills to call (here: forecast_price) to produce { probability } from the live
// market. The market id + target date reach the skill from the collected job params.
// Run: `npm run example:poly-price`.

import { fileURLToPath } from "node:url";

import { runInteractiveAgent } from "../../app/src/runtime/runInteractiveAgent.js";
import { makeSkillProducer } from "../src/index.js";
import { polymarketPriceAgent } from "./polymarketPriceAgent.js";

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
    character: polymarketPriceAgent.character,
    user: parseUser(process.argv.slice(2)),
    // The model picks which declared skill to run (here: forecast_price) to produce the result.
    produce: makeSkillProducer(polymarketPriceAgent.skills),
  });
}

main().catch((err) => {
  console.error(
    "example:poly-price crashed:",
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exit(1);
});
