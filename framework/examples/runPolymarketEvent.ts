// runPolymarketEvent.ts — the BRIDGE that runs the framework `polymarketEventAgent` through the
// app's REAL intake / seal / payment loop AND the free competition loop. It injects an LLM-DRIVEN
// `produce` hook (makeSkillProducer): after payment confirms, the MODEL decides which of the
// agent's declared skills to call (here: guess_event) to produce { guesses }, mapping the collected
// event_id param to the skill's input itself. Run: `npm run example:poly-event`.

import { fileURLToPath } from "node:url";

import { runInteractiveAgent } from "../../app/src/runtime/runInteractiveAgent.js";
import { makeSkillProducer } from "../src/index.js";
import { polymarketEventAgent } from "./polymarketEventAgent.js";

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
    character: polymarketEventAgent.character,
    user: parseUser(process.argv.slice(2)),
    produce: makeSkillProducer(polymarketEventAgent.skills),
  });
}

main().catch((err) => {
  console.error(
    "example:poly-event crashed:",
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exit(1);
});
