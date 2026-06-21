// polymarketResolutionAgent.ts — an EXAMPLE agent built with the Developer Agent Framework. It
// offers one prediction job (Job #1): given a Polymarket market id, guess whether it resolves YES
// or NO. The guess is produced DETERMINISTICALLY by a skill that reads the market's current
// implied prices and picks the favorite; the evaluation engine (polymarket-resolution) scores it
// 100/0 against the market's eventual resolved winner. A real agent replaces the strategy in
// `guess_resolution`. The app harness (via the bridge in runPolymarketResolution.ts) runs it
// through the real intake/seal/payment loop and the free competition loop.

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";
import { fetchMarket } from "./polymarketApi.js";

/**
 * guess_resolution — read the live Polymarket market and return YES or NO. The baseline picks the
 * current favorite (the outcome with the highest implied price); a longer-horizon agent would form
 * its own view. Output matches the template's output schema { outcome }.
 */
export const guessResolution = defineSkill({
  name: "guess_resolution",
  description: "Guess whether a Polymarket market resolves YES or NO from its current favorite.",
  input: z.object({
    marketId: z.string().min(1),
  }),
  output: z.object({
    outcome: z.string().min(1),
  }),
  async run({ input, ctx }) {
    const market = await fetchMarket(ctx.http, input.marketId);
    if (market.outcomes.length === 0) {
      throw new Error(`market ${input.marketId} has no outcomes`);
    }
    // The current favorite (highest implied price). Uppercased to a clean YES/NO; the evaluator
    // compares case-insensitively against the resolved winner.
    return { outcome: market.favorite.toUpperCase() };
  },
});

export const polymarketResolutionAgent = defineAgent({
  name: "PolymarketResolver",
  bio: [
    "I predict whether a Polymarket market resolves YES or NO and deliver it as a sealed job.",
    "I take one prediction job: give me a Polymarket market id and I return YES or NO.",
  ],
  systemPrompt: [
    "You are PolymarketResolver, an agent that sells one job: a YES/NO call on a Polymarket market.",
    "Rules you MUST follow:",
    "- The user must provide a Polymarket market id (the Gamma numeric id).",
    "- You return exactly YES or NO; you never invent the answer yourself — it is produced for you",
    "  from the live market after the job is accepted.",
    "- Once the user has provided a market id, clearly accept the job, e.g. 'Accepted: resolution",
    "  call for market <id>.'",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["prediction"],
  evaluators: ["polymarket-resolution"],
  skills: [guessResolution],
});

export default polymarketResolutionAgent;
