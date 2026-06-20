// politicsPredictionAgent.ts — a Polymarket PRICE specialist for the POLITICS and ELECTION domain
// (evaluator polymarket-price, competition category "prediction"). Given a Polymarket market id and
// a target date (unix seconds), it forecasts the market's YES probability at that date and the
// evaluator scores the Brier closeness to the real CLOB price then.
//
// Politics markets have no clean external "spot" cross-check (unlike a crypto threshold question),
// so this skill is two-signal (see cryptoSignals.ts): it anchors on the live market price and tilts
// by the recent CLOB momentum, damped over the forecast horizon and capped small. The bridge in the
// app's intake/seal/payment loop and the free competition loop drives it like the other examples.

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";
import { fetchRichMarket, fetchYesTrend } from "./cryptoSignals.js";

// How far back to read CLOB history for the momentum signal.
const LOOKBACK_SECONDS = 6 * 3600;
// Momentum is damped (markets barely trend over a short horizon) and the projected drift is capped.
const DRIFT_DAMP = 0.5;
const DRIFT_CAP = 0.05;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * forecast_politics_probability — forecast a politics/elections Polymarket market's YES probability
 * at `targetTs` (unix seconds). Combines two signals into one probability in [0,1]:
 *   anchor  the most recent CLOB YES price (falls back to the Gamma snapshot),
 *   drift   recent CLOB momentum projected over the horizon (damped + capped).
 * There is no spot cross-check: politics markets have no quotable external underlying.
 * Returns only { probability }, matching the polymarket-price template's output schema.
 */
export const forecastPoliticsProbability = defineSkill({
  name: "forecast_politics_probability",
  description:
    "Forecast a politics/elections Polymarket market's YES probability at a target date from the live market price and recent CLOB momentum.",
  input: z.object({
    marketId: z.string().min(1),
    targetTs: z.number().int().nonnegative(),
  }),
  output: z.object({
    probability: z.number(),
  }),
  async run({ input, ctx }) {
    const nowS = Math.floor(Date.now() / 1000);
    const horizonHours = Math.max(0, input.targetTs - nowS) / 3600;

    const market = await fetchRichMarket(ctx.http, input.marketId);
    const trend = await fetchYesTrend(
      ctx.http,
      market.yesTokenId,
      nowS,
      LOOKBACK_SECONDS,
      market.yesPrice,
    );

    const anchor = clamp01(trend.latest);

    // Momentum: project the recent slope over the horizon, damped and capped small.
    const rawDrift = trend.driftPerHour * horizonHours * DRIFT_DAMP;
    const drift = Math.max(-DRIFT_CAP, Math.min(DRIFT_CAP, rawDrift));

    return { probability: clamp01(anchor + drift) };
  },
});

export const politicsPredictionAgent = defineAgent({
  name: "PoliticsForecaster",
  bio: [
    "I forecast the YES probability of politics and election prediction markets and deliver it sealed.",
    "Give me a Polymarket market id (a politics, election, or policy market) and how long to run (e.g. '10 minutes'), and I return a probability in [0,1].",
  ],
  systemPrompt: [
    "You are PoliticsForecaster, a specialist that sells ONE job: a YES-probability (price)",
    "forecast for a POLITICS or ELECTION Polymarket market over a window you choose. This is the",
    "'polymarket-price' job; you do not sell market resolution or whole-event guesses.",
    "Rules you MUST follow:",
    "- You only take politics, elections, and policy markets (candidates, votes, legislation,",
    "  appointments, and the like). Politely decline markets outside that field.",
    "- The user provides a Polymarket market id and HOW LONG to run (a duration like '10 minutes' or",
    "  '1h'). NEVER ask for a date or a unix timestamp — the resolution time is derived from the",
    "  duration after payment; you do not handle timestamps.",
    "- You charge a FLAT FEE of 10 QUADRA per forecast. State this price whenever you discuss or",
    "  accept a job; never leave the price unstated.",
    "- You return a probability between 0 and 1; you never invent it yourself — it is produced for",
    "  you from the live market and its recent price trend after the job is accepted.",
    "- The closer your forecast is to the market's real price at resolution, the higher the score.",
    "- As soon as the user has given you a market id AND a duration, ACCEPT the job in EXACTLY this",
    "  one-line form (fill the angle brackets, keep the labels):",
    "  'Accepted: polymarket-price forecast for market <id>, asset POLITICS, lifetime <Nm>, price 10 QUADRA.'",
    "  <Nm> is the job lifetime (the window the user asks for, written like '10m'); default 7m if unsaid.",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["prediction"],
  skills: [forecastPoliticsProbability],
});

export default politicsPredictionAgent;
