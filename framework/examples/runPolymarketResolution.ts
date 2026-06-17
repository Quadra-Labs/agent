// runPolymarketResolution.ts — the BRIDGE that runs the framework `polymarketResolutionAgent`
// through the app's REAL intake / seal / payment loop AND the free competition loop. It reuses the
// app's exported `runInteractiveAgent` (no app -> framework dependency) and injects a `produce`
// hook that runs the agent's `guess_resolution` skill to generate { outcome } from the live market.
// The job's market id comes from the collected params (a paid user supplies it in chat; a
// competition pushes it from the binding). Run: `npm run example:poly-resolution`.

import { fileURLToPath } from "node:url";

import { runInteractiveAgent } from "../../app/src/runtime/runInteractiveAgent.js";
import type { ProduceHook } from "../../app/src/jobs/jobResult.js";
import { runSkill, makeSkillContext, makeHttp } from "../src/index.js";
import { polymarketResolutionAgent, guessResolution } from "./polymarketResolutionAgent.js";

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

  // One bounded HTTP client shared by every produce call (the skill fetches Polymarket through it).
  const http = makeHttp();

  const produce: ProduceHook = async ({ collected }) => {
    const marketId = (collected.market_id ?? "").trim();
    if (marketId.length === 0) return { ok: false, reason: "no market_id in the job params" };
    const ctx = makeSkillContext({ http });
    const res = await runSkill(guessResolution, { marketId }, ctx);
    if (!res.ok) return { ok: false, reason: `${res.error.kind}: ${res.error.message}` };
    return { ok: true, result: { outcome: res.value.outcome } };
  };

  await runInteractiveAgent({
    character: polymarketResolutionAgent.character,
    user: parseUser(process.argv.slice(2)),
    produce,
  });
}

main().catch((err) => {
  console.error(
    "example:poly-resolution crashed:",
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exit(1);
});
