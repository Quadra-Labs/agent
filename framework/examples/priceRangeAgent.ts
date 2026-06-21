// priceRangeAgent.ts — an EXAMPLE agent built with the Developer Agent Framework. It offers a
// single finance job: guess the BTC/USD price range over a user-chosen window. The actual
// {minPrice, maxPrice} is produced DETERMINISTICALLY by a skill that reads the live Pyth price
// (the same feed the evaluation engine resolves against), so a short window scores ~100. The
// framework piece is `defineAgent` + the `quote_price_range` skill; the app harness (via the
// bridge in run.ts) runs it through the real intake/seal/payment loop.

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";

// The BTC/USD Pyth feed the evaluation engine uses (oracle.rs BTC_USD_FEED_ID; no 0x prefix).
const BTC_USD_FEED_ID = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const HERMES_LATEST = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${BTC_USD_FEED_ID}`;

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
 * quote_price_range — fetch the live BTC/USD price from Pyth and return an integer USD band
 * around it. The band widens modestly with the lifetime (a longer window = more drift), but
 * stays tight for short windows so the in-range score is 100. Output matches the template's
 * output schema { minPrice, maxPrice }. BTC only (the evaluation engine serves only BTC).
 */
export const quotePriceRange = defineSkill({
  name: "quote_price_range",
  description: "Quote a BTC/USD min/max price band from the live Pyth price for a given window.",
  input: z.object({
    asset: z.string().min(1),
    lifetimeMs: z.number().int().positive(),
  }),
  output: z.object({
    minPrice: z.number().int(),
    maxPrice: z.number().int(),
  }),
  async run({ input, ctx }) {
    if (input.asset.toUpperCase() !== "BTC") {
      throw new Error(`only BTC is supported (got ${input.asset})`);
    }
    const body = await ctx.http.getJson(HERMES_LATEST);
    const price = normalizePythUsd(body);
    // Band as a fraction of price, scaled by sqrt(minutes) and capped at 5%. For a 1-2 min
    // window this is a few tenths of a percent — tight enough to score 100 if BTC is steady.
    const minutes = Math.max(1, input.lifetimeMs / 60_000);
    const fraction = Math.min(0.05, 0.0008 * Math.sqrt(minutes));
    const half = Math.max(1, Math.round(price * fraction));
    return { minPrice: price - half, maxPrice: price + half };
  },
});

export const priceRangeAgent = defineAgent({
  name: "PriceRangeOracle",
  bio: [
    "I forecast a BTC/USD price band for a window you choose and deliver it as a sealed job.",
    "I take finance price-range jobs, BTC only, with a lifetime of at least one minute.",
  ],
  systemPrompt: [
    "You are PriceRangeOracle, an agent that sells one job: a BTC/USD price-range guess.",
    "Rules you MUST follow:",
    "- Only BTC is supported. Politely decline any other asset.",
    "- The user picks the lifetime (the window the guess is judged over). It must be at least",
    "  1 minute; if they ask for less, ask for a longer window.",
    "- Always charge exactly 1000000 (QUADRA base units = 1 QUADRA) for the job. State the cost",
    "  as the number 1000000.",
    "- Once the user has confirmed BTC, a lifetime >= 1 minute, and accepted the 1000000 cost,",
    "  clearly say you accept the job: e.g. 'Accepted: BTC price-range for <lifetime>, cost",
    "  1000000.' Do not invent a price range yourself — it is produced for you after payment.",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["finance"],
  evaluators: ["price-range-guess"],
  skills: [quotePriceRange],
});

export default priceRangeAgent;
