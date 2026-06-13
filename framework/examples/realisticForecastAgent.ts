// examples/realisticForecastAgent.ts — btc-price-guess strategy 3 of 3: REALISTIC.
//
// The honest baseline, and the control the engine SHOULD reward over the two gaming agents.
// It makes a genuine short-horizon forecast: fetch recent Coinbase minute closes, fit a
// least-squares trend, extend it, and commit a TIGHT band around the predicted price. It
// does NOT read the engine's oracle and does NOT widen to cheat, so it scores 100 ONLY when
// the resolved price actually lands inside its band — exactly the risk a fair predictor
// takes. Reuses the exported, unit-tested predictBtcPrice strategy from btcResearchAgent.
//
// Built with the framework like btcResearchAgent: a fetch+forecast tool over the global
// fetch, emitting the engine-shaped {minPrice, maxPrice}; the LLM decides when to run it.

import { z } from "zod";

import { defineTool, defineAgent, openai, groq } from "../src/index.js";
import { predictBtcPrice } from "./btcResearchAgent.js";

// Coinbase Exchange minute-candles: newest-first [time, low, high, open, close, volume]
// tuples (~300 most recent). Same source/shape as btcResearchAgent's forecast tool.
const COINBASE_MINUTE_CANDLES =
  "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60";

const CoinbaseCandles = z.array(z.tuple([
  z.number(), // time (unix seconds)
  z.number(), // low
  z.number(), // high
  z.number(), // open
  z.number(), // close
  z.number(), // volume (BTC)
]));

// Default forecast horizon. btc-price-guess jobs resolve a short time after submission, so
// a few minutes ahead is the honest target; the user may override it.
export const DEFAULT_HORIZON_MINUTES = 5;
export const DEFAULT_LOOKBACK_MINUTES = 30;

// The engine REJECTS any interval with maxPrice <= minPrice. predictBtcPrice derives the
// band from recent volatility, which rounds to a zero-width band when the recent closes are
// perfectly flat (vanishingly rare on live BTC, but possible). This floor guarantees a
// valid, non-degenerate interval around the predicted price in that edge case.
export const MIN_HALF_BAND_USD = 1;

/** Build the engine-shaped interval from a forecast, widening to a valid minimum if the
 *  volatility band collapsed to zero width. Pure + unit-testable. */
export function forecastToInterval(
  predictedPrice: number,
  low: number,
  high: number,
): { readonly minPrice: number; readonly maxPrice: number } {
  let minPrice = low;
  let maxPrice = high;
  if (maxPrice - minPrice < 2 * MIN_HALF_BAND_USD) {
    minPrice = predictedPrice - MIN_HALF_BAND_USD;
    maxPrice = predictedPrice + MIN_HALF_BAND_USD;
  }
  return { minPrice: Math.max(1, minPrice), maxPrice };
}

/**
 * forecast_btc_interval — fetch recent Coinbase minute closes, run the least-squares
 * forecast, and return the engine-shaped interval {minPrice, maxPrice} = the forecast's
 * own low/high band. horizonMinutes/lookbackMinutes are inputs the LLM sets from the user.
 * No oracle read, no widening — an honest, falsifiable prediction.
 */
export const forecastBtcIntervalTool = defineTool({
  name: "forecast_btc_interval",
  description:
    "Produce an HONEST btc-price-guess interval by forecasting the BTC price from the " +
    "recent Coinbase minute trend and putting a tight band around it. Set horizonMinutes " +
    "to how far ahead the job resolves (default 5). Returns {minPrice, maxPrice}. Call " +
    "this whenever the user asks for your prediction, guess, interval, or submission.",
  input: z.object({
    horizonMinutes: z
      .number()
      .int()
      .positive()
      .max(120)
      .optional()
      .describe("Minutes ahead the job resolves (1-120); default 5"),
    lookbackMinutes: z
      .number()
      .int()
      .min(2)
      .max(300)
      .optional()
      .describe("Recent minutes of candles to fit the trend on (default 30)"),
  }),
  async handler({ horizonMinutes, lookbackMinutes }) {
    const horizon = horizonMinutes ?? DEFAULT_HORIZON_MINUTES;
    const lookback = lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES;
    const res = await fetch(COINBASE_MINUTE_CANDLES, {
      headers: { "User-Agent": "agent-framework-example" },
    });
    if (!res.ok) {
      throw new Error(`Coinbase Exchange returned ${res.status}`);
    }
    const candles = CoinbaseCandles.parse(await res.json());
    if (candles.length < 2) {
      throw new Error("Coinbase Exchange returned too few candles to forecast");
    }
    // Candles are newest-first; take the recent window and reverse to oldest-first closes.
    const closesOldestFirst = candles.slice(0, lookback).map((c) => c[4]).reverse();
    const forecast = predictBtcPrice(closesOldestFirst, horizon);
    const { minPrice, maxPrice } = forecastToInterval(
      forecast.predictedPrice,
      forecast.low,
      forecast.high,
    );
    return {
      minPrice,
      maxPrice,
      predictedPrice: forecast.predictedPrice,
      currentPrice: forecast.currentPrice,
      horizonMinutes: forecast.horizonMinutes,
      method: forecast.method,
      expectedScoreNote:
        "Honest forecast: scores 100 only if the resolved price lands inside this band; " +
        "otherwise the engine's linear decay applies. No oracle read, no widening.",
    };
  },
});

/**
 * The Realistic Forecast Agent. One file: identity + its one tool. No onTurn — the default
 * turn is the LLM tool loop; the systemPrompt tells it to relay the EXACT interval and to
 * be honest that the score is not guaranteed.
 */
const realisticForecastAgent = defineAgent({
  name: "RealisticForecastAgent",
  bio: [
    "Makes an honest short-horizon BTC forecast and commits a tight btc-price-guess interval.",
  ],
  systemPrompt:
    "You are an honest btc-price-guess prediction agent. WHEN the user asks for your " +
    "prediction, guess, interval, range, or submission: call forecast_btc_interval with " +
    "horizonMinutes set to how far ahead the job resolves if they say so (otherwise omit " +
    "for the default), then answer with the EXACT minPrice and maxPrice it returns as a " +
    "JSON object {\"minPrice\": <n>, \"maxPrice\": <n>}, along with the predicted price and " +
    "a clear note that this scores 100 only if the resolved price lands inside the band — " +
    "it is NOT guaranteed. Never widen the band to chase a guaranteed score; that would " +
    "defeat the point of an honest forecast. " +
    "If the user asks HOW it works: explain it is a least-squares trend extrapolation of " +
    "recent Coinbase minute closes with a random-walk band — a genuine, falsifiable " +
    "prediction, not a read of the engine's oracle. For ANY other message — greetings or " +
    "follow-ups — answer directly WITHOUT calling tools. Never give financial advice.",
  tools: [forecastBtcIntervalTool],
  models: [openai("gpt-4o-mini"), groq("llama-3.3-70b-versatile")],
});

export default realisticForecastAgent;
