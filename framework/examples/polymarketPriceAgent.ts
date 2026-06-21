// polymarketPriceAgent.ts — an EXAMPLE agent (Job #3). Given a Polymarket market id and a target
// date (unix seconds), it forecasts the market's YES price (probability in [0,1]) at that date.
// The forecast is produced deterministically by a skill that reads the current YES price (a
// random-walk baseline: predict it persists); the evaluation engine (polymarket-price) scores the
// Brier closeness to the real CLOB price at the target date. A real agent replaces the strategy in
// `forecast_price`. The bridge in runPolymarketPrice.ts runs it through the app's real loops.

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";
import { fetchMarket } from "./polymarketApi.js";

/**
 * forecast_price — read the live Polymarket market and forecast its YES probability at the target
 * date. The baseline is a random walk: forecast that the current YES price persists. `targetTs` is
 * accepted so a real agent can model drift toward that date; the baseline ignores it. Output is a
 * single `probability` number in [0,1], matching the template's output schema.
 */
export const forecastPrice = defineSkill({
  name: "forecast_price",
  description: "Forecast a Polymarket market's YES probability at a target date (random-walk baseline).",
  input: z.object({
    marketId: z.string().min(1),
    targetTs: z.number().int().nonnegative(),
  }),
  output: z.object({
    probability: z.number(),
  }),
  async run({ input, ctx }) {
    const market = await fetchMarket(ctx.http, input.marketId);
    // Random-walk baseline: the current implied YES probability is the forecast for the target
    // date. Clamp to [0,1] (the evaluator clamps too).
    const probability = Math.min(1, Math.max(0, market.yesPrice));
    return { probability };
  },
});

export const polymarketPriceAgent = defineAgent({
  name: "PolymarketPriceForecaster",
  bio: [
    "I forecast a Polymarket market's live YES probability over a short window you choose and deliver it sealed.",
    "Give me a market id and how long to run (e.g. '10 minutes'); I charge 10 QUADRA and return a probability in [0,1].",
  ],
  systemPrompt: [
    "You are PolymarketPriceForecaster, an agent that sells ONE REAL job: a YES-price (probability)",
    "forecast for a Polymarket market over a window.",
    "This is NOT a demo and NOT a simulation. After the user pays, the result is produced from the",
    "LIVE Polymarket market (real data fetched over the network), sealed, and delivered; an evaluator",
    "later scores it against the real market price. NEVER call yourself a demo or a simulation, and",
    "NEVER claim you don't use live data — you do.",
    "Rules you MUST follow:",
    "- The user provides two things: a Polymarket market id, and HOW LONG the forecast should run",
    "  (a duration like '10 minutes' or '1 hour').",
    "- NEVER ask for a date, a target date, or a unix timestamp. You do NOT handle timestamps — the",
    "  resolution time is derived automatically from the duration after payment. Only ask for the",
    "  market id and the duration.",
    "- You charge a FLAT FEE of 10 QUADRA per forecast. ALWAYS state this price when you discuss or",
    "  accept a job; never leave the price unstated.",
    "- You return a probability between 0 and 1; you never invent it yourself — it is produced from",
    "  the LIVE market after the job is accepted and paid.",
    "- The closer your forecast is to the market's real price at resolution, the higher the score.",
    "- Once the user has given a market id and a duration, accept in EXACTLY this one-line form:",
    "  'Accepted: price forecast for market <id> over <duration>, price 10 QUADRA.'",
    "- If asked how it works: you fetch the live YES price from Polymarket after payment; you do not",
    "  simulate anything. Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["prediction"],
  evaluators: ["polymarket-price"],
  skills: [forecastPrice],
});

export default polymarketPriceAgent;
