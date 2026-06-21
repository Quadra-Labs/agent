// ethPriceBandAgent.ts — an EXAMPLE finance agent built with the Developer Agent Framework. It
// sells one job: a price-range band for ETH/USD (also BTC/SOL/SUI) over a user-chosen horizon.
// The actual {minPrice, maxPrice} band is produced DETERMINISTICALLY by a skill that reads the
// live Pyth price (the same Hermes feed the evaluation engine resolves against, asset.rs), so a
// short horizon scores ~100. The band widens with sqrt(horizon) to mirror price diffusion, which
// is exactly how the price-range-guess scorer (price_range.rs) sizes its tolerance. The framework
// piece is `defineAgent` + the `quote_eth_band` skill; the app harness runs it through the real
// intake/seal/payment loop.

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";

// Pyth Hermes feed ids (no 0x prefix), copied from the evaluation engine's curated asset map
// (asset.rs). Keeping this in sync means the agent's anchor matches the price the engine scores.
const FEED_IDS: Readonly<Record<string, string>> = {
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  SUI: "23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
};

const hermesLatest = (feedId: string): string =>
  `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}`;

// Normalize a Pyth Hermes "latest" response to a whole-USD integer, rounding to nearest — the
// SAME normalization the evaluation engine does (oracle.rs normalize_to_usd), so the agent's
// anchor matches the price the engine will score against.
function normalizePythUsd(body: unknown): number {
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
  const raw = BigInt(price.price);
  const expo = price.expo;
  if (raw <= 0n) throw new Error("pyth: non-positive price");
  if (expo < 0) {
    const scale = 10n ** BigInt(-expo);
    const dollars = (raw + scale / 2n) / scale; // round to nearest
    return Number(dollars);
  }
  return Number(raw * 10n ** BigInt(expo));
}

// Parse a horizon string like "30s", "5m", "1h", "2d" into milliseconds — the SAME grammar the
// engine uses (job.rs parse_lifetime_ms). Defaults to 5 minutes on any unparseable input so the
// deterministic band is always producible.
function horizonToMs(horizon: string): number {
  const trimmed = horizon.trim();
  const match = /^(\d+)\s*([smhd])$/i.exec(trimmed);
  if (match === null) return 5 * 60_000;
  const amount = Number(match[1] ?? "0");
  const unit = (match[2] ?? "m").toLowerCase();
  const unitMs = unit === "s" ? 1_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 60_000;
  const ms = amount * unitMs;
  return ms > 0 ? ms : 5 * 60_000;
}

/**
 * quote_eth_band — fetch the live price for the asset from Pyth and return a USD min/max band
 * around it. The band widens with sqrt(horizon-minutes) and is capped at 5%, mirroring the
 * scorer's sqrt(time) tolerance: a short horizon stays tight enough to score 100 if the price is
 * steady, a longer one leaves room for drift. Output matches the template's { minPrice, maxPrice }.
 * ETH is the default/preferred asset; BTC, SOL, and SUI are also accepted.
 */
export const quoteEthBand = defineSkill({
  name: "quote_eth_band",
  description: "Quote an ETH/USD (or BTC/SOL/SUI) min/max price band from the live Pyth price for a horizon.",
  input: z.object({
    asset: z.string(),
    horizon: z.string(),
  }),
  output: z.object({
    minPrice: z.number(),
    maxPrice: z.number(),
  }),
  async run({ input, ctx }) {
    const symbol = input.asset.trim().toUpperCase() === "" ? "ETH" : input.asset.trim().toUpperCase();
    const feedId = FEED_IDS[symbol];
    if (feedId === undefined) {
      throw new Error(`unsupported asset ${symbol} (supported: ETH, BTC, SOL, SUI)`);
    }
    const body = await ctx.http.getJson(hermesLatest(feedId));
    const price = normalizePythUsd(body);
    // Band as a fraction of price, scaled by sqrt(minutes) and capped at 5%. For a 1-2 min horizon
    // this is a few tenths of a percent — tight enough to score 100 if the price is steady.
    const minutes = Math.max(1, horizonToMs(input.horizon) / 60_000);
    const fraction = Math.min(0.05, 0.0008 * Math.sqrt(minutes));
    const half = Math.max(1, Math.round(price * fraction));
    return { minPrice: price - half, maxPrice: price + half };
  },
});

export const ethPriceBandAgent = defineAgent({
  name: "EthPriceBandAgent",
  bio: [
    "I forecast an ETH/USD price band for a horizon you choose and deliver it as a sealed job.",
    "I specialize in ETH but also take BTC, SOL, and SUI price-range jobs.",
  ],
  systemPrompt: [
    "You are EthPriceBandAgent, a finance specialist that sells ONE job: a price-range band",
    "(minPrice, maxPrice) for where an asset will be at the end of a horizon. This is the",
    "'price-range-guess' job.",
    "Rules you MUST follow:",
    "- You take FINANCE price-range jobs only. ETH is your default and preferred asset; you also",
    "  accept BTC, SOL, and SUI. Politely decline any other asset or any out-of-field request.",
    "- The user provides the asset and a horizon (a short duration string like '5m', '1h', '2d').",
    "  If they don't name an asset, assume ETH. If they don't give a horizon, default to 5m.",
    "- You charge a FLAT FEE of 10 QUADRA per band. State this price whenever you discuss or accept",
    "  a job; never leave the price unstated.",
    "- You return the { minPrice, maxPrice } band; you never invent it yourself — it is produced for",
    "  you from the live Pyth price after the job is accepted. The closer the real end price is to",
    "  inside your band, the higher the score.",
    "- As soon as you have an asset (or the ETH default) AND a horizon, ACCEPT the job in EXACTLY",
    "  this one-line form (fill the angle brackets, keep the labels):",
    "  'Accepted: price-range band for <ASSET>, asset <ASSET>, lifetime <Nm>, price 10 QUADRA.'",
    "  <ASSET> is the ticker (ETH, BTC, SOL, or SUI). <Nm> is the horizon written like '5m'.",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["finance"],
  evaluators: ["price-range-guess"],
  skills: [quoteEthBand],
});

export default ethPriceBandAgent;
