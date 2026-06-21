// solPriceBandAgent.ts — an EXAMPLE finance agent built with the Developer Agent Framework. It
// offers a single SCORED job: guess the SOL/USD price band over a user-chosen window. The actual
// {minPrice, maxPrice} is produced DETERMINISTICALLY by a skill that reads the live Pyth price
// (the same feed family the evaluation engine resolves against), so a short window scores ~100.
// It is the SOL sibling of priceRangeAgent.ts (which is BTC-only): it defaults to and prefers
// SOL. The framework piece is `defineAgent` + the `quote_sol_price_band` skill; the app harness
// (via the bridge in run.ts) runs it through the real intake/seal/payment loop.

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";

// The SOL/USD Pyth feed (Hermes price feed id; no 0x prefix), the SOL counterpart of the BTC
// feed used in priceRangeAgent.ts.
const SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const HERMES_LATEST = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${SOL_USD_FEED_ID}`;

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

/**
 * quote_sol_price_band — fetch the live SOL/USD price from Pyth and return an integer USD band
 * around it. The band widens modestly with the lifetime (a longer window = more drift), but
 * stays tight for short windows so the in-range score is 100. Output matches the template's
 * output schema { minPrice, maxPrice }. SOL is the preferred asset (the agent defaults to it).
 */
export const quoteSolPriceBand = defineSkill({
  name: "quote_sol_price_band",
  description: "Quote a SOL/USD min/max price band from the live Pyth price for a given window.",
  input: z.object({
    asset: z.string().min(1).default("SOL"),
    lifetimeMs: z.number().int().positive(),
  }),
  output: z.object({
    minPrice: z.number().int(),
    maxPrice: z.number().int(),
  }),
  async run({ input, ctx }) {
    if (input.asset.toUpperCase() !== "SOL") {
      throw new Error(`only SOL is supported (got ${input.asset})`);
    }
    const body = await ctx.http.getJson(HERMES_LATEST);
    const price = normalizePythUsd(body);
    // Band as a fraction of price, scaled by sqrt(minutes) and capped at 5%. For a 1-2 min
    // window this is a few tenths of a percent — tight enough to score 100 if SOL is steady.
    const minutes = Math.max(1, input.lifetimeMs / 60_000);
    const fraction = Math.min(0.05, 0.0008 * Math.sqrt(minutes));
    const half = Math.max(1, Math.round(price * fraction));
    return { minPrice: price - half, maxPrice: price + half };
  },
});

export const solPriceBandAgent = defineAgent({
  name: "SolPriceBandOracle",
  bio: [
    "I forecast a SOL/USD price band for a window you choose and deliver it as a sealed job.",
    "I take finance price-range jobs, SOL only, with a lifetime of at least one minute.",
  ],
  systemPrompt: [
    "You are SolPriceBandOracle, a finance specialist that sells ONE job: a SOL/USD price-range guess.",
    "Rules you MUST follow:",
    "- You only forecast SOL price bands. SOL is the default and preferred asset; politely decline",
    "  any other asset and any request outside the SOL price-range field.",
    "- The user picks the lifetime (the window the guess is judged over). It must be at least",
    "  1 minute; if they ask for less, ask for a longer window. If they don't say, default to 7m.",
    "- You charge a FLAT FEE of 10 QUADRA per job. State this price whenever you discuss or accept a",
    "  job; never leave the price unstated.",
    "- You return a { minPrice, maxPrice } USD band; you never invent it yourself — it is produced",
    "  for you from the live SOL/USD price after the job is accepted.",
    "- The tighter your band still containing the real price at scoring time, the higher the score.",
    "- As soon as the user has confirmed SOL and a lifetime >= 1 minute, ACCEPT the job in EXACTLY",
    "  this one-line form (fill the angle brackets, keep the labels):",
    "  'Accepted: SOL price-range forecast, asset SOL, lifetime <Nm>, price 10 QUADRA.'",
    "  <Nm> is the job lifetime (time until scoring), written like '7m'.",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["finance"],
  evaluators: ["price-range-guess"],
  skills: [quoteSolPriceBand],
});

export default solPriceBandAgent;
