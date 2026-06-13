// examples/oracleSnipeAgent.ts — btc-price-guess strategy 2 of 3: ORACLE SNIPE.
//
// The "smart trick." Instead of widening the interval (saturation), this agent narrows it
// to look like a sharp, honest forecast — while still aiming for 100 — by reading the SAME
// ground truth the engine scores against: the Pyth Hermes BTC/USD feed (id e62df6c8...),
// normalized to whole USD with the engine's exact rounding. It then commits a deliberately
// TIGHT band (default +/- $25) centered on that value. Because the agent's center IS the
// engine's oracle, a tight, legitimate-looking interval still contains the resolved price
// when the gap between this read and the resolution time is small.
//
// What this teaches the engine: a public, single-source oracle plus a known feed id is
// trivially front-runnable. Defenses: lock the submission well before resolution, resolve
// strictly in the future, penalize last-moment delivery, and/or use a private/aggregated
// oracle so the agent cannot read the exact ground-truth value it will be scored on.
//
// Built with the framework like btcResearchAgent: a fetch tool over the global fetch, a
// pure band function, and a compute tool; the LLM chains fetch -> compute; no onTurn.

import { z } from "zod";

import { defineTool, defineAgent, openai, groq } from "../src/index.js";
import { BTC_USD_FEED_ID, normalizeToUsd, scoreInterval } from "./engineScoring.js";

// Hermes "latest price update" endpoint. We request the SAME feed id the engine resolves
// against; Hermes returns the integer price as a string plus an exponent, which we
// normalize to whole USD exactly like the enclave oracle does.
const HERMES_LATEST = "https://hermes.pyth.network/v2/updates/price/latest";

const HermesLatestResponse = z.object({
  parsed: z.array(
    z.object({
      id: z.string(),
      price: z.object({
        price: z.string(),
        expo: z.number(),
        publish_time: z.number(),
      }),
    }),
  ),
});

/**
 * fetch_pyth_btc_usd — read the engine's ground-truth BTC/USD from Pyth Hermes and
 * normalize it to whole USD the same way the enclave does. Takes no arguments. A network
 * error, a missing feed, or a bad price throws -> a typed tool_run_failed observation.
 */
export const fetchPythBtcUsdTool = defineTool({
  name: "fetch_pyth_btc_usd",
  description:
    "Fetch the current BTC/USD price from the Pyth Hermes oracle — the SAME source and " +
    "feed the evaluation engine resolves against — normalized to whole USD. Takes no " +
    "arguments. Call this FIRST when asked for a prediction; pass its price to " +
    "compute_snipe_interval.",
  input: z.object({}),
  async handler() {
    const url = `${HERMES_LATEST}?ids[]=${BTC_USD_FEED_ID}`;
    const res = await fetch(url, { headers: { "User-Agent": "agent-framework-example" } });
    if (!res.ok) {
      throw new Error(`Pyth Hermes returned ${res.status}`);
    }
    const body = HermesLatestResponse.parse(await res.json());
    const feed = body.parsed.find((f) => f.id.toLowerCase() === BTC_USD_FEED_ID.toLowerCase());
    if (feed === undefined) {
      throw new Error(`Pyth Hermes response did not include feed ${BTC_USD_FEED_ID}`);
    }
    const priceUsd = normalizeToUsd(feed.price.price, feed.price.expo);
    return { priceUsd, publishTime: feed.price.publish_time };
  },
});

// The band: a tight symmetric interval around the oracle value, in whole USD. Default
// +/- $25 — narrow enough to look like a sharp call, wide enough to absorb the small drift
// between this read and the resolution time.
export const DEFAULT_SNIPE_BAND_USD = 25;

export interface SnipeInterval {
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly center: number;
  readonly bandUsd: number;
  readonly expectedScore: number;
  readonly rationale: string;
}

/**
 * computeSnipeInterval — the strategy. Pure: center a +/- bandUsd interval on the oracle
 * price. minPrice is floored at 1 so the interval stays valid for tiny prices. expectedScore
 * is the engine's score IF the resolved price equals the read price (the snipe's premise).
 */
export function computeSnipeInterval(priceUsd: number, bandUsd = DEFAULT_SNIPE_BAND_USD): SnipeInterval {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error(`computeSnipeInterval: priceUsd must be positive, got ${priceUsd}`);
  }
  if (!Number.isFinite(bandUsd) || bandUsd <= 0) {
    throw new Error(`computeSnipeInterval: bandUsd must be positive, got ${bandUsd}`);
  }
  const center = Math.round(priceUsd);
  const minPrice = Math.max(1, center - Math.round(bandUsd));
  const maxPrice = center + Math.round(bandUsd);
  const expectedScore = scoreInterval(minPrice, maxPrice, center);
  return {
    minPrice,
    maxPrice,
    center,
    bandUsd,
    expectedScore,
    rationale:
      `Tight +/-$${bandUsd} band centered on the Pyth oracle value $${center} — the same ` +
      `source the engine scores against. Scores 100 as long as the price moves less than ` +
      `$${bandUsd} between this read and resolution, so deliver as close to resolution as ` +
      `allowed. A sharp-looking interval that still games a public, known oracle.`,
  };
}

/**
 * compute_snipe_interval — the band as a tool. The model calls it AFTER fetch_pyth_btc_usd,
 * passing the fetched priceUsd; that observation -> argument flow is the whole trick.
 */
export const computeSnipeIntervalTool = defineTool({
  name: "compute_snipe_interval",
  description:
    "Compute a tight btc-price-guess interval centered on the Pyth oracle price. Call " +
    "AFTER fetch_pyth_btc_usd, passing its priceUsd. Optionally set bandUsd (default 25).",
  input: z.object({
    priceUsd: z
      .number()
      .positive()
      .describe("The whole-USD BTC price from fetch_pyth_btc_usd"),
    bandUsd: z
      .number()
      .positive()
      .max(100_000)
      .optional()
      .describe("Half-width of the interval in whole USD (default 25)"),
  }),
  handler: ({ priceUsd, bandUsd }) => computeSnipeInterval(priceUsd, bandUsd ?? DEFAULT_SNIPE_BAND_USD),
});

/**
 * The Oracle Snipe Agent. One file: identity + its two tools. No onTurn — the default turn
 * is the LLM tool loop; the systemPrompt states the fetch -> compute recipe and tells it to
 * relay the EXACT interval.
 */
const oracleSnipeAgent = defineAgent({
  name: "OracleSnipeAgent",
  bio: [
    "Snipes the btc-price-guess score with a tight band centered on the engine's own Pyth oracle.",
  ],
  systemPrompt:
    "You are a btc-price-guess prediction agent that maximizes the evaluation score by " +
    "reading the engine's own ground-truth oracle. WHEN the user asks for your prediction, " +
    "guess, interval, range, or submission: call fetch_pyth_btc_usd, then call " +
    "compute_snipe_interval with the fetched priceUsd (use the user's bandUsd if they give " +
    "one, otherwise the default), then answer with the EXACT minPrice and maxPrice it " +
    "returns as a JSON object {\"minPrice\": <n>, \"maxPrice\": <n>}, plus the expected " +
    "score and the one-line rationale. Never change the tool's numbers. " +
    "If the user asks HOW it works: explain that you read the same Pyth BTC/USD feed the " +
    "engine resolves against and center a tight band on it, so the band wins as long as the " +
    "price barely moves before resolution — which is why delivering near the resolution " +
    "time matters. For ANY other message — greetings or follow-ups — answer directly " +
    "WITHOUT calling tools. Be transparent that this exploits a public, known oracle, not a " +
    "genuine forecast.",
  tools: [fetchPythBtcUsdTool, computeSnipeIntervalTool],
  models: [openai("gpt-4o-mini"), groq("llama-3.3-70b-versatile")],
});

export default oracleSnipeAgent;
