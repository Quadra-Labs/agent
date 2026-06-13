// examples/btcResearchAgent.ts — example 2: the BTC Research Agent (LLM-chained tools).
//
// Proves MULTI-STEP TOOL CHAINING BY THE MODEL: the user asks for the BTC price and a
// range; the agent's LLM first runs fetch_btc_price (the developer's "connect to an
// oracle" function), reads the spot from the observation, then runs compute_btc_range
// WITH THAT SPOT as its argument, and answers from the computed band. The data flows
// observation -> next tool call entirely through the model's decisions — there is NO
// onTurn and NO hand-written sequencing. (The M6 version fetched via a skill and
// computed in a deterministic loop; the tools workstream hands both steps to the LLM
// over the in-process MCP server.)
//
// BOTH TOOLS ARE PLAIN FUNCTIONS. fetch_btc_price hits the public Coinbase spot
// endpoint with the global fetch; compute_btc_range wraps the pure, unit-testable
// computeBtcRange below (exported unchanged). The strategy stays a DETERMINISTIC,
// explainable computation (NOT financial advice, NOT a prediction) — the model decides
// WHEN to run it, the developer's code decides WHAT it computes.
//
// Checkpoint-on-close still runs. Only the framework's public surface is imported.

import { z } from "zod";

import { defineTool, defineAgent, openai, groq } from "../src/index.js";

// Coinbase spot price endpoint: { data: { amount: "63543.02", base: "BTC", currency } }.
// amount is a STRING in the API; the tool parses it to a number as part of its contract.
const COINBASE_SPOT = "https://api.coinbase.com/v2/prices/BTC-USD/spot";

const CoinbaseSpotResponse = z.object({
  data: z.object({
    amount: z.string(),
    base: z.string(),
    currency: z.string(),
  }),
});

/**
 * fetch_btc_price — the "oracle fetch": a plain async function hitting the public
 * Coinbase API. Takes no arguments. A network error or a NaN amount throws -> the
 * framework feeds a typed tool_run_failed observation back to the model.
 */
export const fetchBtcPriceTool = defineTool({
  name: "fetch_btc_price",
  description:
    "Fetch the current BTC/USD spot price from the public Coinbase API. " +
    "Takes no arguments. Call this FIRST for any price or range question.",
  input: z.object({}),
  async handler() {
    const res = await fetch(COINBASE_SPOT);
    if (!res.ok) {
      throw new Error(`Coinbase returned ${res.status}`);
    }
    const data = CoinbaseSpotResponse.parse(await res.json());
    const price = Number(data.data.amount);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Coinbase returned a non-numeric amount: ${data.data.amount}`);
    }
    return { price, currency: data.data.currency };
  },
});

// Coinbase Exchange minute-candles: newest-first [time, low, high, open, close, volume]
// tuples (~300 most recent). Summing the newest N volumes gives the BTC traded in the
// last N minutes — a rolling window, not a calendar bucket.
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

/**
 * fetch_btc_volume — the BTC traded on Coinbase over the last `windowMinutes` minutes.
 * The window is a real INPUT the LLM sets from the user's request (e.g. "last 30 mins"
 * -> 30), so the answer matches what was asked. The returned windowMinutes echoes the
 * window ACTUALLY summed (fewer than asked only if the API returned fewer candles).
 */
export const fetchBtcVolumeTool = defineTool({
  name: "fetch_btc_volume",
  description:
    "Fetch the total BTC traded on Coinbase over a recent rolling window. Set " +
    "windowMinutes to the number of minutes the user asked about (e.g. 30 for the " +
    "last 30 minutes); defaults to 60. Use whenever the user asks about trading volume.",
  input: z.object({
    windowMinutes: z
      .number()
      .int()
      .positive()
      .max(300)
      .optional()
      .describe("Rolling window in minutes (1-300); default 60"),
  }),
  async handler({ windowMinutes }) {
    const requested = windowMinutes ?? 60;
    const res = await fetch(COINBASE_MINUTE_CANDLES, {
      headers: { "User-Agent": "agent-framework-example" },
    });
    if (!res.ok) {
      throw new Error(`Coinbase Exchange returned ${res.status}`);
    }
    const candles = CoinbaseCandles.parse(await res.json());
    if (candles.length === 0) {
      throw new Error("Coinbase Exchange returned no candles");
    }
    const window = candles.slice(0, requested);
    const volumeBtc = window.reduce((sum, candle) => sum + candle[5], 0);
    return {
      volumeBtc: Number(volumeBtc.toFixed(2)),
      windowMinutes: window.length, // the window actually summed (<= requested)
    };
  },
});

// The strategy: a symmetric band around spot at a fixed width, with the method stated.
// Pure + unit-testable in isolation (no network, no framework). Exported unchanged from
// M6 — the tools workstream changes WHO decides to run it (the model), not what it does.
export interface BtcRange {
  readonly spot: number;
  readonly low: number;
  readonly high: number;
  readonly bandPct: number;
  readonly explanation: string;
}

export function computeBtcRange(spot: number, bandPct = 5): BtcRange {
  if (!Number.isFinite(spot) || spot <= 0) {
    throw new Error(`computeBtcRange: spot must be a positive finite number, got ${spot}`);
  }
  const factor = bandPct / 100;
  const low = Math.round(spot * (1 - factor));
  const high = Math.round(spot * (1 + factor));
  return {
    spot,
    low,
    high,
    bandPct,
    explanation:
      `A simple +/-${bandPct}% band around the current spot of $${Math.round(spot)}, ` +
      `giving an illustrative range of $${low} to $${high}. ` +
      `This is a mechanical band, not a forecast or financial advice.`,
  };
}

/**
 * compute_btc_range — the strategy as a tool. The model calls it AFTER fetch_btc_price,
 * passing the fetched spot — that argument flow (observation -> next call) is exactly
 * the multi-step capability this example proves.
 */
export const computeBtcRangeTool = defineTool({
  name: "compute_btc_range",
  description:
    "Compute a simple illustrative +/- percentage band around a BTC spot price. " +
    "Call this AFTER fetch_btc_price, passing the fetched spot price.",
  input: z.object({
    spot: z
      .number()
      .positive()
      .describe("The BTC spot price in USD, taken from fetch_btc_price's result"),
    bandPct: z
      .number()
      .positive()
      .max(50)
      .optional()
      .describe("Band width in percent (default 5)"),
  }),
  handler: ({ spot, bandPct }) => computeBtcRange(spot, bandPct ?? 5),
});

// --- short-horizon forecast (ILLUSTRATIVE, not financial advice) -------------------
// A deterministic, explainable extrapolation: fit a least-squares line to the recent
// minute closes to get a trend (USD/min), extend it from the latest close by the
// requested horizon, and put a random-walk band around it from the recent per-minute
// volatility (stepStdDev * sqrt(horizon)). Pure + unit-testable; the model decides WHEN
// to run it, this code decides WHAT it computes.
export interface BtcForecast {
  readonly currentPrice: number;
  readonly predictedPrice: number;
  readonly horizonMinutes: number;
  readonly trendUsdPerMin: number;
  readonly low: number;
  readonly high: number;
  readonly method: string;
}

export function predictBtcPrice(
  closesOldestFirst: readonly number[],
  horizonMinutes: number,
): BtcForecast {
  const n = closesOldestFirst.length;
  if (n < 2) {
    throw new Error("predictBtcPrice: need at least 2 recent closes");
  }
  if (!Number.isFinite(horizonMinutes) || horizonMinutes <= 0) {
    throw new Error(`predictBtcPrice: horizonMinutes must be positive, got ${horizonMinutes}`);
  }
  // Least-squares slope of close vs minute index (x = 0..n-1) -> trend in USD/min.
  const meanX = (n - 1) / 2;
  const meanY = closesOldestFirst.reduce((sum, y) => sum + y, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - meanX) * (closesOldestFirst[i] - meanY);
    den += (i - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const currentPrice = closesOldestFirst[n - 1];
  const predictedPrice = Math.round(currentPrice + slope * horizonMinutes);
  // Random-walk band: std-dev of per-minute steps, scaled by sqrt(horizon).
  const steps: number[] = [];
  for (let i = 1; i < n; i += 1) steps.push(closesOldestFirst[i] - closesOldestFirst[i - 1]);
  const meanStep = steps.reduce((sum, v) => sum + v, 0) / steps.length;
  const variance = steps.reduce((sum, v) => sum + (v - meanStep) ** 2, 0) / steps.length;
  const band = Math.round(Math.sqrt(variance) * Math.sqrt(horizonMinutes));
  return {
    currentPrice: Math.round(currentPrice),
    predictedPrice,
    horizonMinutes,
    trendUsdPerMin: Number(slope.toFixed(2)),
    low: predictedPrice - band,
    high: predictedPrice + band,
    method:
      `Least-squares trend over the last ${n} minute-closes (${slope >= 0 ? "+" : ""}` +
      `${slope.toFixed(2)} USD/min) extended ${horizonMinutes} min from the latest close, ` +
      `with a +/-$${band} random-walk band. Illustrative mechanical extrapolation, ` +
      `NOT a forecast to trade on or financial advice.`,
  };
}

/**
 * predict_btc_price — the forecast as a tool. Fetches recent Coinbase minute candles
 * (the oracle), then runs predictBtcPrice on the recent closes. The horizon is an INPUT
 * the LLM sets from the user's request ("17 minutes later" -> 17).
 */
export const predictBtcPriceTool = defineTool({
  name: "predict_btc_price",
  description:
    "Produce a short-horizon ILLUSTRATIVE BTC price extrapolation N minutes ahead from " +
    "the recent Coinbase minute trend. Use when the user asks for a prediction or " +
    "forecast 'in/after N minutes'. The result is a mechanical extrapolation, not advice.",
  input: z.object({
    horizonMinutes: z
      .number()
      .int()
      .positive()
      .max(120)
      .describe("Minutes ahead to extrapolate (1-120), e.g. 17 for '17 minutes later'"),
    lookbackMinutes: z
      .number()
      .int()
      .min(2)
      .max(300)
      .optional()
      .describe("Recent minutes of candles to fit the trend on (default 30)"),
  }),
  async handler({ horizonMinutes, lookbackMinutes }) {
    const lookback = lookbackMinutes ?? 30;
    const res = await fetch(COINBASE_MINUTE_CANDLES, {
      headers: { "User-Agent": "agent-framework-example" },
    });
    if (!res.ok) {
      throw new Error(`Coinbase Exchange returned ${res.status}`);
    }
    const candles = CoinbaseCandles.parse(await res.json());
    if (candles.length < 2) {
      throw new Error("Coinbase Exchange returned too few candles to extrapolate");
    }
    // Candles are newest-first; take the recent window and reverse to oldest-first closes.
    const closesOldestFirst = candles.slice(0, lookback).map((c) => c[4]).reverse();
    return predictBtcPrice(closesOldestFirst, horizonMinutes);
  },
});

/**
 * The BTC Research Agent. One file: identity + its declared tools. No onTurn — the
 * default turn is the LLM tool loop, and the systemPrompt states the recipes so the
 * model chains the tools in order. No templates, no Intake.
 */
const btcResearchAgent = defineAgent({
  name: "BtcResearchAgent",
  bio: ["Fetches the current BTC price and explains a simple illustrative range."],
  // The WHEN matters as much as the HOW: state the tool recipe for price questions,
  // but ALSO state what to do for everything else (answer conversationally, explain
  // the method, no tools). Without the second half, models re-run the recipe on every
  // message — including "how did you get this price?".
  systemPrompt:
    "You are a careful, conversational market-data assistant. " +
    "WHEN the user asks for the BTC price or a price range: call fetch_btc_price, " +
    "then call compute_btc_range with the fetched spot, then answer using the " +
    "computed range. " +
    "WHEN the user asks about trading volume: call fetch_btc_volume with " +
    "windowMinutes set to the period they asked about (e.g. 30 for the last 30 " +
    "minutes; omit for the default 60), then answer using the window it actually " +
    "covered. " +
    "WHEN the user asks for a prediction or forecast for N minutes ahead (e.g. '17 " +
    "minutes later'): call predict_btc_price with horizonMinutes set to N, then answer " +
    "using its output. ALWAYS present it as a mechanical extrapolation of the recent " +
    "trend, not a forecast to trade on; you MAY share this illustrative figure and band. " +
    "For ANY other message — greetings, follow-ups, or questions about your method — " +
    "answer directly WITHOUT calling tools. If asked how you got a price: it comes " +
    "from the public Coinbase spot API; the range is a mechanical +/- percentage band " +
    "around that spot; volume comes from Coinbase minute candles; and a prediction is a " +
    "least-squares trend extrapolation of recent Coinbase minute closes. Never give " +
    "financial advice.",
  tools: [fetchBtcPriceTool, computeBtcRangeTool, fetchBtcVolumeTool, predictBtcPriceTool],
  // Base model + fallback: OpenAI first; on any failure (missing key, outage, rate
  // limit) the chain falls back to Groq. Keys resolve lazily from env at call time.
  models: [openai("gpt-4o-mini"), groq("llama-3.3-70b-versatile")],
});

export default btcResearchAgent;
