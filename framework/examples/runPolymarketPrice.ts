// runPolymarketPrice.ts — the BRIDGE that runs the framework `polymarketPriceAgent` through the
// app's REAL intake / seal / payment loop AND the free competition loop. It injects a `produce`
// hook that runs the agent's `forecast_price` skill to generate { probability } from the live
// market. The market id + target date come from the collected params (target_ts is unix seconds).
// Run: `npm run example:poly-price`.

import { fileURLToPath } from "node:url";

import { runInteractiveAgent } from "../../app/src/runtime/runInteractiveAgent.js";
import type { ProduceHook } from "../../app/src/jobs/jobResult.js";
import { runSkill, makeSkillContext, makeHttp } from "../src/index.js";
import { polymarketPriceAgent, forecastPrice } from "./polymarketPriceAgent.js";

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
    const targetTs = Number(collected.target_ts ?? "");
    if (!Number.isFinite(targetTs) || targetTs < 0) {
      return { ok: false, reason: "target_ts must be a unix-seconds timestamp" };
    }
    const ctx = makeSkillContext({ http });
    const res = await runSkill(forecastPrice, { marketId, targetTs: Math.floor(targetTs) }, ctx);
    if (!res.ok) return { ok: false, reason: `${res.error.kind}: ${res.error.message}` };
    return { ok: true, result: { probability: res.value.probability } };
  };

  await runInteractiveAgent({
    character: polymarketPriceAgent.character,
    user: parseUser(process.argv.slice(2)),
    produce,
  });
}

main().catch((err) => {
  console.error(
    "example:poly-price crashed:",
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exit(1);
});
