// runPolymarketResolutionForecaster.ts — the BRIDGE that runs the framework
// `polymarketResolutionForecaster` through the app's REAL intake / seal / payment loop (and the
// free competition loop). It injects a `produce` hook that runs the agent's `call_market_resolution`
// skill to generate { outcome } from the live market. The market id arrives in the collected params
// (the polymarket-resolution template's only param is `market_id`). Run from agent/framework:
//   npx tsx examples/runPolymarketResolutionForecaster.ts --user demo-user

import { fileURLToPath } from "node:url";

import { runInteractiveAgent } from "../../app/src/runtime/runInteractiveAgent.js";
import type { ProduceHook } from "../../app/src/jobs/jobResult.js";
import { runSkill, makeSkillContext, makeHttp } from "../src/index.js";
import {
  polymarketResolutionForecaster,
  callMarketResolution,
} from "./polymarketResolutionForecaster.js";

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
    const marketId = (collected.market_id ?? "").trim();
    if (marketId.length === 0) return { ok: false, reason: "no market_id in the job params" };
    const ctx = makeSkillContext({ http });
    const res = await runSkill(callMarketResolution, { marketId }, ctx);
    if (!res.ok) return { ok: false, reason: `${res.error.kind}: ${res.error.message}` };
    // Surface the call on stderr so a live run is observable (the sealed result is { outcome }).
    console.error(`resolution: market ${marketId} -> ${res.value.outcome}`);
    return { ok: true, result: { outcome: res.value.outcome } };
  };

  await runInteractiveAgent({
    character: polymarketResolutionForecaster.character,
    user: parseUser(process.argv.slice(2)),
    produce,
  });
}

main().catch((err) => {
  console.error(
    "polymarket-resolution-forecaster crashed:",
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exit(1);
});
