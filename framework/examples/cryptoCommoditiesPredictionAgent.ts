// cryptoCommoditiesPredictionAgent.ts — a Polymarket PRICE specialist for the crypto and
// commodities domain (evaluator polymarket-price, competition category "prediction"). Given a
// Polymarket market id and a target date (unix seconds), it forecasts the market's YES probability
// at that date and the evaluator scores the Brier closeness to the real CLOB price then.
//
// Unlike the random-walk baseline in polymarketPriceAgent.ts, this skill is genuinely multi-signal
// (see cryptoSignals.ts): it anchors on the live market price, tilts by the recent CLOB momentum
// (damped over the forecast horizon), and cross-checks against the underlying asset's spot price
// when the market is a crypto threshold question. The bridge in runCryptoCommoditiesPrediction.ts
// runs it through the app's real intake/seal/payment loop and the free competition loop.

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";
import {
  fetchRichMarket,
  fetchYesTrend,
  fetchSpotUsd,
  readSemantics,
} from "./cryptoSignals.js";

// How far back to read CLOB history for the momentum signal.
const LOOKBACK_SECONDS = 6 * 3600;
// Momentum is damped (markets barely trend over a short horizon) and the projected drift is capped.
const DRIFT_DAMP = 0.5;
const DRIFT_CAP = 0.05;
// A clear spot-vs-threshold gap nudges the forecast toward the determined outcome, but only partly.
const SPOT_GAP_MIN = 0.02;
const SPOT_NUDGE_MAX = 0.3;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * forecast_crypto_probability — forecast a crypto/commodities Polymarket market's YES probability
 * at `targetTs` (unix seconds). Combines three signals into one probability in [0,1]:
 *   anchor  the most recent CLOB YES price (falls back to the Gamma snapshot),
 *   drift   recent CLOB momentum projected over the horizon (damped + capped),
 *   spot    a guarded nudge when the market is a crypto threshold question and the underlying's
 *           live spot is clearly past/short of that threshold.
 * Returns only { probability }, matching the polymarket-price template's output schema.
 */
export const forecastCryptoProbability = defineSkill({
  name: "forecast_crypto_probability",
  description:
    "Forecast a crypto/commodities Polymarket market's YES probability at a target date from the live market price, recent CLOB momentum, and the underlying's spot price.",
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

    // Spot cross-check: only when the market is a crypto threshold question with a clear direction.
    let spotNudge = 0;
    const sem = readSemantics(market.question, market.description);
    if (sem.cryptoTicker !== null && sem.usdThreshold !== null && sem.direction !== "unknown") {
      const spot = await fetchSpotUsd(ctx.http, sem.cryptoTicker);
      if (spot !== null && sem.usdThreshold > 0) {
        const gapFrac = Math.abs(spot - sem.usdThreshold) / sem.usdThreshold;
        if (gapFrac > SPOT_GAP_MIN) {
          const determined =
            sem.direction === "down" ? spot <= sem.usdThreshold : spot >= sem.usdThreshold;
          const target = determined ? 0.95 : 0.05;
          spotNudge = (target - anchor) * Math.min(SPOT_NUDGE_MAX, gapFrac);
        }
      }
    }

    return { probability: clamp01(anchor + drift + spotNudge) };
  },
});

export const cryptoCommoditiesPredictionAgent = defineAgent({
  name: "CryptoCommoditiesForecaster",
  bio: [
    "I forecast the YES probability of crypto and commodities prediction markets and deliver it sealed.",
    "Give me a Polymarket market id (a crypto or commodities market) and a target date, and I return a probability in [0,1].",
  ],
  systemPrompt: [
    "You are CryptoCommoditiesForecaster, a specialist that sells ONE job: a YES-probability (price)",
    "forecast for a CRYPTO or COMMODITIES Polymarket market at a target date. This is the",
    "'polymarket-price' job; you do not sell market resolution or whole-event guesses.",
    "Rules you MUST follow:",
    "- You only take crypto and commodities markets (Bitcoin, Ethereum, oil, gold, and the like).",
    "  Politely decline markets outside that field.",
    "- The user must provide a Polymarket market id and a target date (a unix-seconds timestamp).",
    "- You charge a FLAT FEE of 10 QUADRA per forecast. State this price whenever you discuss or",
    "  accept a job; never leave the price unstated.",
    "- You return a probability between 0 and 1; you never invent it yourself — it is produced for",
    "  you from the live market, its recent price trend, and the underlying spot after the job is accepted.",
    "- The closer your forecast is to the market's real price at the target date, the higher the score.",
    "- As soon as the user has given you a market id AND a target date, ACCEPT the job in EXACTLY this",
    "  one-line form (fill the angle brackets, keep the labels):",
    "  'Accepted: polymarket-price forecast for market <id>, asset <SYMBOL>, target <unix_ts>,",
    "   lifetime <Nm>, price 10 QUADRA.'",
    "  <SYMBOL> is the underlying ticker you infer from the market (e.g. BTC for a Bitcoin market).",
    "  <Nm> is the job lifetime (time until scoring): use the window the user asks for, written like",
    "  '7m'; if they don't say, default to 7m.",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["prediction"],
  skills: [forecastCryptoProbability],
});

export default cryptoCommoditiesPredictionAgent;
