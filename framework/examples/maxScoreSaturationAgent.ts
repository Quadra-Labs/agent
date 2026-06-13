// examples/maxScoreSaturationAgent.ts — btc-price-guess strategy 1 of 3: SATURATION.
//
// The bluntest possible attack on the engine's scoring rule. The scorer awards 100 for
// ANY interval that contains the resolved price and never penalizes how WIDE that interval
// is — the only validation is maxPrice > minPrice. So the score-maximizing prediction is
// simply the widest valid interval: it is mathematically certain to contain the resolved
// BTC price, and therefore scores 100 every single time, deterministically, with no fetch.
//
// What this teaches the engine: it needs a maximum-width / minimum-precision cap (reward
// sharpness), otherwise a single hard-coded interval dominates every honest forecaster.
//
// Built with the framework exactly like btcResearchAgent: a pure, unit-testable strategy
// function wrapped in a plain-function tool the LLM decides to run; no onTurn.

import { z } from "zod";

import { defineTool, defineAgent, openai, groq } from "../src/index.js";
import { scoreInterval } from "./engineScoring.js";

// The widest interval we are willing to commit to. minPrice = 1 (the oracle rejects any
// non-positive price, so the resolved price is always >= 1); maxPrice = 1,000,000,000 USD
// per BTC is astronomically above any conceivable price AND is an exact f64 integer (well
// under 2^53), so it serializes losslessly as a JSON number.
export const SATURATION_MIN_PRICE = 1;
export const SATURATION_MAX_PRICE = 1_000_000_000;

export interface SaturationInterval {
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly expectedScore: number;
  readonly rationale: string;
}

/**
 * computeSaturationInterval — the strategy. Pure, deterministic, no network: return the
 * widest valid interval. We assert the engine's own scoring against a representative price
 * so `expectedScore` is computed, not asserted by hand.
 */
export function computeSaturationInterval(): SaturationInterval {
  const minPrice = SATURATION_MIN_PRICE;
  const maxPrice = SATURATION_MAX_PRICE;
  // Any in-range probe yields 100; use a typical BTC price to demonstrate it concretely.
  const expectedScore = scoreInterval(minPrice, maxPrice, 100_000);
  return {
    minPrice,
    maxPrice,
    expectedScore,
    rationale:
      `Widest valid interval [${minPrice}, ${maxPrice}] USD. The engine scores 100 for ` +
      `ANY interval containing the resolved price and never penalizes width, so any ` +
      `BTC price is inside this band -> guaranteed 100, with no oracle fetch needed.`,
  };
}

/**
 * compute_saturation_interval — the strategy as a tool. Takes no arguments; the answer is
 * a fixed, certain interval, so there is nothing to fetch and nothing for the model to vary.
 */
export const computeSaturationIntervalTool = defineTool({
  name: "compute_saturation_interval",
  description:
    "Produce the score-maximizing btc-price-guess interval for the evaluation engine. " +
    "Takes no arguments. Returns the widest valid {minPrice, maxPrice} that is certain " +
    "to contain the resolved BTC price (guaranteed score 100). Call this whenever the " +
    "user asks for the prediction, guess, interval, or submission.",
  input: z.object({}),
  handler: () => computeSaturationInterval(),
});

/**
 * The Saturation Agent. One file: identity + its one tool. No onTurn — the default turn is
 * the LLM tool loop, and the systemPrompt tells it to relay the tool's EXACT numbers.
 */
const maxScoreSaturationAgent = defineAgent({
  name: "MaxScoreSaturationAgent",
  bio: [
    "Maximizes the btc-price-guess evaluation score by committing to the widest valid interval.",
  ],
  systemPrompt:
    "You are a btc-price-guess prediction agent whose single goal is the maximum " +
    "evaluation score. WHEN the user asks for your prediction, guess, interval, range, or " +
    "submission: call compute_saturation_interval, then answer with the EXACT minPrice and " +
    "maxPrice it returns, presented as a JSON object {\"minPrice\": <n>, \"maxPrice\": <n>}, " +
    "plus the expected score and the one-line rationale. Never round, widen, or shrink the " +
    "numbers the tool returns. " +
    "If the user asks HOW it works or WHY it scores 100: explain that the engine awards 100 " +
    "for any interval containing the resolved price with no penalty for width, so the widest " +
    "valid interval is certain to contain it. For ANY other message — greetings or " +
    "follow-ups — answer directly WITHOUT calling the tool. Be transparent that this is a " +
    "deliberate exploit of the engine's scoring rule, not a market forecast.",
  tools: [computeSaturationIntervalTool],
  models: [openai("gpt-4o-mini"), groq("llama-3.3-70b-versatile")],
});

export default maxScoreSaturationAgent;
