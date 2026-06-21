// btcUpDownAgent.ts — an EXAMPLE finance agent built with the Developer Agent Framework. It offers
// a single SCORED job: call whether BTC/USD finishes higher (up) or lower (down) over a user-chosen
// window, with a confidence. The call is produced by a skill that reads the LIVE BTC/USD Pyth price
// and its EMA: spot above the EMA = recent drift up. The evaluation engine (up-down-guess) scores it
// with a Brier rule against the real start->end move (start price delivered via /start_data). It is
// the up/down sibling of priceRangeAgent.ts (band) and movement-percentage. A real agent replaces
// the momentum baseline in `quote_up_down`; the app harness runs it through the real
// intake/seal/payment loop.

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";

// The BTC/USD Pyth feed the evaluation engine resolves against (oracle.rs BTC_USD_FEED_ID; no 0x).
const BTC_USD_FEED_ID = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const HERMES_LATEST = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${BTC_USD_FEED_ID}`;

// Pull the spot price and its EMA (both as floats) from a Pyth Hermes "latest" response. They share
// the feed's exponent and we only compare them, so we keep full precision rather than rounding to
// whole USD the way the band agents do.
function pythPriceAndEma(body: unknown): { price: number; ema: number } {
  const parsed = (body as { parsed?: unknown }).parsed;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("pyth: no parsed price in response");
  }
  const row = parsed[0] as {
    price?: { price?: unknown; expo?: unknown };
    ema_price?: { price?: unknown; expo?: unknown };
  };
  const read = (p: { price?: unknown; expo?: unknown } | undefined): number => {
    if (p === undefined || typeof p.price !== "string" || typeof p.expo !== "number") {
      throw new Error("pyth: malformed price object");
    }
    return Number(BigInt(p.price)) * 10 ** p.expo;
  };
  const price = read(row.price);
  const ema = read(row.ema_price);
  if (!(price > 0) || !(ema > 0)) throw new Error("pyth: non-positive price");
  return { price, ema };
}

/**
 * quote_up_down — read the live BTC/USD Pyth price and its EMA and call the direction. Baseline:
 * spot above its EMA means the recent drift is up, so call up; below, call down. Confidence scales
 * with the size of the gap but stays modest (the direction over a short window is genuinely
 * uncertain), in [0.5, 0.75]. Output matches the template's output schema { isUp, confidence }.
 */
export const quoteUpDown = defineSkill({
  name: "quote_up_down",
  description: "Call BTC up or down over a window from live Pyth momentum (spot vs its EMA).",
  input: z.object({
    asset: z.string().min(1).default("BTC"),
    lifetimeMs: z.number().int().positive(),
  }),
  output: z.object({
    isUp: z.boolean(),
    confidence: z.number(),
  }),
  async run({ input, ctx }) {
    if (input.asset.toUpperCase() !== "BTC") {
      throw new Error(`only BTC is supported (got ${input.asset})`);
    }
    const { price, ema } = pythPriceAndEma(await ctx.http.getJson(HERMES_LATEST));
    // Momentum baseline. Confidence grows with the relative gap but is capped low: calling a short
    // window is a coin-flip-ish bet, and the Brier rule punishes overconfident wrong calls hardest.
    const gap = Math.abs(price - ema) / ema;
    const confidence = Math.min(0.75, 0.5 + gap * 20);
    return { isUp: price >= ema, confidence };
  },
});

export const btcUpDownAgent = defineAgent({
  name: "BtcUpDownOracle",
  bio: [
    "I call whether BTC/USD finishes higher or lower over a window you choose and deliver it sealed.",
    "I take finance up/down jobs, BTC only, with a lifetime of at least one minute.",
  ],
  systemPrompt: [
    "You are BtcUpDownOracle, a finance specialist that sells ONE job: a BTC up/down call.",
    "This is NOT a demo and NOT a simulation. After the user pays, the call is produced from the",
    "LIVE BTC/USD Pyth price (real data fetched over the network), sealed, and delivered; an",
    "evaluator later scores it against the real start->end move. NEVER call yourself a demo or claim",
    "you don't use live data — you do.",
    "Rules you MUST follow:",
    "- You only call BTC up or down. BTC is the only asset; politely decline any other asset and any",
    "  request outside the BTC up/down field.",
    "- The user picks the lifetime (the window the call is judged over). It must be at least",
    "  1 minute; if they ask for less, ask for a longer window. If they don't say, default to 7m.",
    "- You charge a FLAT FEE of 10 QUADRA per job. State this price whenever you discuss or accept a",
    "  job; never leave the price unstated.",
    "- You return an { isUp, confidence } call; you never invent it yourself — it is produced for you",
    "  from the live BTC/USD price after the job is accepted and paid.",
    "- A correct, confident call scores highest; a wrong, confident call scores worst.",
    "- As soon as the user has confirmed BTC and a lifetime >= 1 minute, ACCEPT the job in EXACTLY",
    "  this one-line form (fill the angle brackets, keep the labels):",
    "  'Accepted: BTC up/down call, asset BTC, lifetime <Nm>, price 10 QUADRA.'",
    "  <Nm> is the job lifetime (time until scoring), written like '7m'.",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["finance"],
  evaluators: ["up-down-guess"],
  skills: [quoteUpDown],
});

export default btcUpDownAgent;
