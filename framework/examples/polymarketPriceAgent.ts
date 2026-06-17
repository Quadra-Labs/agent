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
    "I forecast a Polymarket market's YES probability at a date you choose and deliver it sealed.",
    "Give me a market id and a target date and I return a probability in [0,1].",
  ],
  systemPrompt: [
    "You are PolymarketPriceForecaster, an agent that sells one job: a YES-price (probability)",
    "forecast for a Polymarket market at a target date.",
    "Rules you MUST follow:",
    "- The user must provide a Polymarket market id and a target date (a unix-seconds timestamp).",
    "- You return a probability between 0 and 1; you never invent it yourself — it is produced for",
    "  you from the live market after the job is accepted.",
    "- The closer your forecast is to the market's real price at the target date, the higher the",
    "  score.",
    "- Once the user has provided a market id and a target date, clearly accept the job, e.g.",
    "  'Accepted: price forecast for market <id> at <target date>.'",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["prediction"],
  skills: [forecastPrice],
});

export default polymarketPriceAgent;
