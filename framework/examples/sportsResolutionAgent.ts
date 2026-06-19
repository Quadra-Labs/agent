// sportsResolutionAgent.ts — a YES/NO RESOLUTION specialist for SPORTS markets (evaluator
// polymarket-resolution, competition category "prediction"). Given a Polymarket market id it calls
// whether the market resolves YES or NO; the evaluator scores 100 if the call matches the market's
// resolved winner, else 0 (so the market must have resolved by scoring time).
//
// Unlike polymarketResolutionForecaster.ts, this skill has NO crypto-spot cross-check (a sports
// market has no underlying spot to read). It is purely market-price driven: it anchors on the live
// implied YES price (which converges to ~1 or ~0 once a market resolves) and returns the WINNING
// SIDE's exact outcome label, so a non-Yes/No binary market still matches.

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";
import { fetchRichMarket } from "./cryptoSignals.js";

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * call_sports_resolution — read the live Polymarket market and call its resolved side, anchored
 * purely on the implied YES probability (which converges to ~1 or ~0 once the market resolves).
 * Returns the exact outcome label of the called side (matches the evaluator's case-insensitive
 * comparison against the resolved winner). Output matches the template's schema { outcome }.
 */
export const callSportsResolution = defineSkill({
  name: "call_sports_resolution",
  description:
    "Call whether a sports Polymarket market resolves YES or NO, from its live implied price.",
  input: z.object({
    marketId: z.string().min(1),
  }),
  output: z.object({
    outcome: z.string().min(1),
  }),
  async run({ input, ctx }) {
    const market = await fetchRichMarket(ctx.http, input.marketId);
    if (market.outcomes.length === 0) {
      throw new Error(`market ${input.marketId} has no outcomes`);
    }

    // Anchor: the live implied YES probability. Once a market resolves this is ~1 (YES won) or ~0.
    const prob = clamp01(market.yesPrice);

    // Return the WINNING SIDE's exact outcome label (binary market: the YES side or the other side).
    const yesIdx = Math.max(
      0,
      market.outcomes.findIndex((o) => o.trim().toLowerCase() === "yes"),
    );
    const otherIdx = market.outcomes.length > 1 ? (yesIdx === 0 ? 1 : 0) : yesIdx;
    const label = prob >= 0.5 ? market.outcomes[yesIdx] : market.outcomes[otherIdx];
    return { outcome: (label ?? "Yes").trim() };
  },
});

export const sportsResolutionAgent = defineAgent({
  name: "SportsResolutionAgent",
  bio: [
    "I call whether a sports Polymarket market resolves YES or NO and deliver the call sealed.",
    "Give me a Polymarket market id for a sports market and I return the side I expect it to resolve to.",
  ],
  systemPrompt: [
    "You are SportsResolutionAgent, a specialist that sells ONE job: a YES/NO resolution call for a",
    "SPORTS Polymarket market. This is the 'polymarket-resolution' job; you do not sell price",
    "forecasts or whole-event guesses.",
    "Rules you MUST follow:",
    "- You only take SPORTS markets (game winners, match outcomes, season totals, and the like).",
    "  Politely decline markets outside that field (crypto, politics, commodities, and so on).",
    "- The user must provide a Polymarket market id (the Gamma numeric id).",
    "- You charge a FLAT FEE of 10 QUADRA per call. State this price whenever you discuss or accept a",
    "  job; never leave the price unstated.",
    "- You return exactly the side you expect the market to resolve to (e.g. Yes or No); you never",
    "  invent it — it is produced for you from the live market's implied price after the job is accepted.",
    "- As soon as the user gives you a market id, ACCEPT the job in EXACTLY this one-line form (fill",
    "  the angle brackets, keep the labels):",
    "  'Accepted: polymarket-resolution call for market <id>, asset SPORT, lifetime <Nm>, price 10 QUADRA.'",
    "  <Nm> is the job lifetime (time until scoring), written like '3m'; if the user doesn't say,",
    "  default to 3m.",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["prediction"],
  skills: [callSportsResolution],
});

export default sportsResolutionAgent;
