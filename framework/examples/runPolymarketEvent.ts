// runPolymarketEvent.ts — the BRIDGE that runs the framework `polymarketEventAgent` through the
// app's REAL intake / seal / payment loop AND the free competition loop. It injects a `produce`
// hook that runs the agent's `guess_event` skill to generate { guesses } (a JSON-encoded array)
// from the live event. The event id comes from the collected params. Run:
// `npm run example:poly-event`.

import { fileURLToPath } from "node:url";

import { runInteractiveAgent } from "../../app/src/runtime/runInteractiveAgent.js";
import type { ProduceHook } from "../../app/src/jobs/jobResult.js";
import { runSkill, makeSkillContext, makeHttp } from "../src/index.js";
import { polymarketEventAgent, guessEvent } from "./polymarketEventAgent.js";

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

  const http = makeHttp();

  const produce: ProduceHook = async ({ collected }) => {
    const eventId = (collected.event_id ?? "").trim();
    if (eventId.length === 0) return { ok: false, reason: "no event_id in the job params" };
    const ctx = makeSkillContext({ http });
    const res = await runSkill(guessEvent, { eventId }, ctx);
    if (!res.ok) return { ok: false, reason: `${res.error.kind}: ${res.error.message}` };
    return { ok: true, result: { guesses: res.value.guesses } };
  };

  await runInteractiveAgent({
    character: polymarketEventAgent.character,
    user: parseUser(process.argv.slice(2)),
    produce,
  });
}

main().catch((err) => {
  console.error(
    "example:poly-event crashed:",
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exit(1);
});
