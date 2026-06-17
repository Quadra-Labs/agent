// marketProducer.ts — a real result producer (ProduceHook) for the finance competition/paid jobs.
// It REPLACES the blind LLM guess with a data-driven result:
//   - price-range jobs ({minPrice, maxPrice}): fetch the live Pyth price for the asset (the SAME
//     feed the evaluation engine resolves against) and return a band centered on it, widened with
//     sqrt(lifetime) to roughly match the scorer's volatility tolerance (price_range.rs:
//     tol = start*sqrt(seconds)/10000). Tight for short windows, so a steady market scores high.
//   - trading jobs ({trades, ...}): a hold baseline (no trades) — an honest market-drift ROI.
// This is a REAL example: prices move, so scores vary; perfect 100 is not expected. Network/asset
// failures return a typed reason (the caller treats it as retryable). NEVER throws.

import type { ProduceHook, JobResult } from "./jobResult.js";
import type { IntakeTemplate } from "../templates/intakeTemplate.js";
import { parseDurationMs } from "../templates/intakeTemplate.js";

// Asset -> Pyth Hermes feed id (no 0x prefix). MUST match the evaluation engine's asset map
// (evaluation-engine asset.rs) so the agent anchors on the same price the engine scores against.
const FEEDS: Record<string, string> = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  SUI: "23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
};

// Round to 1e-8 precision (the oracle's fixed-point scale), avoiding float tails.
function round8(x: number): number {
  return Math.round(x * 1e8) / 1e8;
}

// Normalize a Pyth Hermes "latest" response to a FRACTIONAL USD price. The new evaluation engine
// keeps full 1e-8 precision (oracle.rs PRICE_SCALE) so cheap assets (SUI, SOL) must NOT be rounded
// to whole dollars; the price_range scorer parses the agent's min/max as floats.
function normalizePythPrice(body: unknown): number {
  const parsed = (body as { parsed?: unknown }).parsed;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("pyth: no parsed price in response");
  }
  const price = (parsed[0] as { price?: unknown }).price as
    | { price?: unknown; expo?: unknown }
    | undefined;
  if (price === undefined || typeof price.price !== "string" || typeof price.expo !== "number") {
    throw new Error("pyth: malformed price object");
  }
  const raw = Number(price.price);
  if (!Number.isFinite(raw) || raw <= 0) throw new Error("pyth: non-positive price");
  // value = raw * 10^expo (expo is negative for crypto feeds -> a fractional dollar value).
  return round8(raw * Math.pow(10, price.expo));
}

async function fetchPythPrice(asset: string): Promise<number> {
  const feed = FEEDS[asset.trim().toUpperCase()];
  if (!feed) throw new Error(`unsupported asset "${asset}" (supported: ${Object.keys(FEEDS).join(", ")})`);
  const res = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feed}`);
  if (!res.ok) throw new Error(`pyth responded ${res.status}`);
  return normalizePythPrice(await res.json());
}

// True when the template's output is exactly { minPrice, maxPrice } (the price-range job).
function isPriceRange(output: IntakeTemplate["output"]): boolean {
  const keys = Object.keys(output);
  return keys.length === 2 && "minPrice" in output && "maxPrice" in output;
}

// Produce a USD band centered on the live price, half-width ~ price * 0.0008 * sqrt(minutes)
// (capped at 5%), which tracks the scorer's sqrt-of-lifetime tolerance.
async function producePriceRange(
  asset: string,
  collected: Record<string, string>,
  template: IntakeTemplate,
): Promise<JobResult> {
  const price = await fetchPythPrice(asset);
  const lifetimeMs =
    parseDurationMs(collected.horizon ?? "") ?? template.minimumLifetimeMs ?? 300_000;
  const minutes = Math.max(1, lifetimeMs / 60_000);
  const fraction = Math.min(0.05, 0.0008 * Math.sqrt(minutes));
  const half = price * fraction; // fractional USD; tracks the scorer's sqrt(lifetime) tolerance
  const minPrice = round8(price - half);
  let maxPrice = round8(price + half);
  if (maxPrice <= minPrice) maxPrice = round8(minPrice + Math.max(half, 1e-8)); // keep max > min
  return { minPrice, maxPrice };
}

// Produce a result for a trading job by filling the template's output keys: `trades` is an empty
// JSON array (a hold baseline — ride the starting allocation), other string fields a short note,
// number fields 0. Honest market-drift ROI; a smarter strategy can replace this later.
function produceTrading(output: IntakeTemplate["output"]): JobResult {
  const result: JobResult = {};
  for (const [key, type] of Object.entries(output)) {
    if (key === "trades") result[key] = "[]";
    else if (type === "number") result[key] = 0;
    else result[key] = "hold: ride the starting allocation";
  }
  return result;
}

/**
 * The market producer. Handles finance price-range and trading templates; for any other template
 * it declines (ok:false) so it is only used where it makes sense. NEVER throws.
 */
export const marketProducer: ProduceHook = async ({ template, collected }) => {
  try {
    if (isPriceRange(template.output)) {
      const asset = (collected.asset ?? "").trim() || template.allowedAssets?.[0] || "BTC";
      const result = await producePriceRange(asset, collected, template);
      return { ok: true, result };
    }
    if ("trades" in template.output) {
      return { ok: true, result: produceTrading(template.output) };
    }
    return { ok: false, reason: `market producer does not handle template "${template.id}"` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "market producer failed" };
  }
};
