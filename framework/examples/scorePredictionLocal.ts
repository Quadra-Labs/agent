// scorePredictionLocal.ts — drive a REAL prediction job into a LOCALLY-run polymarket eval engine,
// without the competition engine (which needs a published package). It runs the agent's real
// forecast skill against the live market and POSTs the SAME payload shape the competition engine's
// buildPredictionPayload sends to /process_data, then prints the signed score. No mocks: the
// evaluator resolves ground truth from Polymarket itself.
//
// Two-step short-forward run (honest, no peeking at the target price):
//   1) now:            tsx examples/scorePredictionLocal.ts --market 2410575 --target +1200
//                      -> prints the forecast P; the engine 400s with "in the future" until target passes.
//   2) after ~20 min:  tsx examples/scorePredictionLocal.ts --market 2410575 --target <same abs ts> --probability P
//                      -> posts the SAME forecast and returns the real Brier score.
// For an instant smoke instead, use a recent-past target (e.g. --target -3600).

import { runSkill, makeSkillContext, makeHttp } from "../src/index.js";
import { forecastCryptoProbability } from "./cryptoCommoditiesPredictionAgent.js";

// A placeholder agent identity (64 hex). The score is computed from real market data regardless of
// who the agent is; a registered wallet would go here in a real competition.
const PLACEHOLDER_AGENT = "0x" + "11".repeat(32);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

// Lifetime like "30m"/"45s"/"1h" -> ms (mirrors the enclave's parse_lifetime_ms units).
function lifetimeMs(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s.trim());
  if (!m) throw new Error(`bad --lifetime "${s}" (use e.g. 30m, 45s, 1h)`);
  const n = Number(m[1]);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return n * unit;
}

// --target accepts an absolute unix-seconds ts, or "+N"/"-N" seconds relative to now.
function resolveTargetTs(raw: string, nowS: number): number {
  if (raw.startsWith("+")) return nowS + Number(raw.slice(1));
  if (raw.startsWith("-")) return nowS - Number(raw.slice(1));
  return Number(raw);
}

async function main(): Promise<void> {
  const marketId = (arg("market") ?? "").trim();
  const targetRaw = arg("target");
  if (marketId.length === 0 || targetRaw === undefined) {
    throw new Error("usage: --market <gamma id> --target <unix s | +secs | -secs> [--probability P] [--eval URL] [--lifetime 30m]");
  }
  const evalUrl = (arg("eval") ?? "http://localhost:3000").replace(/\/$/, "");
  const category = arg("category") ?? "polymarket-price";
  const lifetime = arg("lifetime") ?? "30m";
  const nowMs = Date.now();
  const nowS = Math.floor(nowMs / 1000);
  const targetTs = resolveTargetTs(targetRaw, nowS);

  const http = makeHttp();

  // The forecast: a fixed --probability (for the step-2 score, no recompute) or the real skill now.
  let probability: number;
  const override = arg("probability");
  if (override !== undefined) {
    probability = Number(override);
    console.log(`using supplied forecast probability=${probability}`);
  } else {
    const ctx = makeSkillContext({ http });
    const res = await runSkill(forecastCryptoProbability, { marketId, targetTs }, ctx);
    if (!res.ok) throw new Error(`forecast failed: ${res.error.kind}: ${res.error.message}`);
    probability = res.value.probability;
    console.log(`forecast: market ${marketId} @ ${targetTs} -> probability=${probability}`);
  }

  const payload = {
    payload: {
      agent_id: PLACEHOLDER_AGENT,
      category_id: category,
      job_id: `local-${nowMs}`,
      agent_result: { probability },
      job_template: { output: { probability: "number" }, lifetime },
      started_at_ms: nowMs,
      delivered_at_ms: nowMs,
      params: { market_id: marketId, target_ts: String(targetTs) },
      window: { start_ms: nowMs, end_ms: nowMs + lifetimeMs(lifetime) },
    },
  };

  const res = await fetch(`${evalUrl}/process_data`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const msg = await res.text();
    console.error(`eval engine ${res.status}: ${msg}`);
    if (/in the future/i.test(msg)) {
      console.error(`-> target_ts is not in the past yet. Re-run after it passes with --probability ${probability}`);
    }
    process.exit(1);
  }

  const body = (await res.json()) as {
    response: { data: { score: number; finalized_price: number | string } };
    signature: string;
  };
  const { score, finalized_price } = body.response.data;
  const actualProb = Number(finalized_price) / 10_000; // price category echoes the actual price in bps
  console.log("--- scored ---");
  console.log(`forecast probability : ${probability}`);
  console.log(`actual market price  : ${actualProb} (${finalized_price} bps)`);
  console.log(`Brier score          : ${score} / 100`);
  console.log(`signature            : ${body.signature.slice(0, 24)}... (ed25519 over the IntentMessage)`);
}

main().catch((err) => {
  console.error("scorePredictionLocal crashed:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
