// macroPredictionAgent.ts — a Polymarket PRICE specialist for the MACRO / ECONOMICS domain
// (Fed rate decisions, CPI/inflation prints, recession calls, GDP). It sells the same
// 'polymarket-price' job as the crypto/commodities forecaster (evaluator polymarket-price,
// competition category "prediction"): given a Polymarket market id and a target date (unix
// seconds), it forecasts the market's YES probability at that date and the evaluator scores
// the Brier closeness to the real CLOB price then.
//
// Macro markets have no tradable underlying spot to cross-check, so this skill drops the spot
// signal entirely and forecasts from two structural signals only (see cryptoSignals.ts):
// the live market price (anchor) plus the recent CLOB momentum projected over the horizon
// (damped + capped). No spot, no LLM, no fs — the only I/O is ctx.http.getJson.

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";
import { fetchRichMarket, fetchYesTrend } from "./cryptoSignals.js";

// How far back to read CLOB history for the momentum signal.
const LOOKBACK_SECONDS = 6 * 3600;
// Momentum is damped (macro markets barely trend over a short horizon) and the drift is capped.
const DRIFT_DAMP = 0.5;
const DRIFT_CAP = 0.05;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * forecast_macro_probability — forecast a macro/economics Polymarket market's YES probability
 * at `targetTs` (unix seconds). Combines two signals into one probability in [0,1]:
 *   anchor  the most recent CLOB YES price (falls back to the Gamma snapshot),
 *   drift   recent CLOB momentum projected over the horizon (damped + capped).
 * There is no spot cross-check (macro markets have no quotable underlying).
 * Returns only { probability }, matching the polymarket-price template's output schema.
 */
export const forecastMacroProbability = defineSkill({
  name: "forecast_macro_probability",
  description:
    "Forecast a macro/economics Polymarket market's YES probability at a target date from the live market price and recent CLOB momentum (no spot).",
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

export const macroPredictionAgent = defineAgent({
  name: "MacroPredictionForecaster",
  bio: [
    "I forecast the YES probability of macro and economics prediction markets and deliver it sealed.",
    "Give me a Polymarket market id (a Fed-rate, CPI, recession, or GDP market) and a target date, and I return a probability in [0,1].",
  ],
  systemPrompt: [
    "You are MacroPredictionForecaster, a specialist that sells ONE job: a YES-probability (price)",
    "forecast for a MACRO or ECONOMICS Polymarket market at a target date. This is the",
    "'polymarket-price' job; you do not sell market resolution or whole-event guesses.",
    "Rules you MUST follow:",
    "- You only take macro and economics markets (Fed rate decisions, CPI and inflation prints,",
    "  recession calls, GDP, unemployment, and the like). Politely decline markets outside that field.",
    "- The user must provide a Polymarket market id and a target date (a unix-seconds timestamp).",
    "- You charge a FLAT FEE of 10 QUADRA per forecast. State this price whenever you discuss or",
    "  accept a job; never leave the price unstated.",
    "- You return a probability between 0 and 1; you never invent it yourself — it is produced for",
    "  you from the live market and its recent price trend after the job is accepted.",
    "- The closer your forecast is to the market's real price at the target date, the higher the score.",
    "- As soon as the user has given you a market id AND a target date, ACCEPT the job in EXACTLY this",
    "  one-line form (fill the angle brackets, keep the labels):",
    "  'Accepted: polymarket-price forecast for market <id>, asset MACRO, target <unix_ts>,",
    "   lifetime <Nm>, price 10 QUADRA.'",
    "  <Nm> is the job lifetime (time until scoring): use the window the user asks for, written like",
    "  '7m'; if they don't say, default to 7m.",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["prediction"],
  skills: [forecastMacroProbability],
});

export default macroPredictionAgent;
