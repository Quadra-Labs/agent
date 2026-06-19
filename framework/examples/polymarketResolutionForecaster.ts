// polymarketResolutionForecaster.ts — a YES/NO RESOLUTION specialist (evaluator
// polymarket-resolution, competition category "prediction"). Given a Polymarket market id it calls
// whether the market resolves YES or NO; the evaluator scores 100 if the call matches the market's
// resolved winner, else 0 (so the market must have resolved by scoring time).
//
// Unlike the favorite-only baseline (polymarketResolutionAgent.ts), this skill is multi-signal (the
// same layer the price agent uses, cryptoSignals.ts): it anchors on the live implied YES price
// (which converges to ~1 or ~0 once a market resolves) and, for a CRYPTO threshold market, nudges
// toward the determined side using the underlying's live spot. It returns the WINNING SIDE's exact
// outcome label so a non-Yes/No binary market still matches. The bridge in
// runPolymarketResolutionForecaster.ts runs it through the app's real intake/seal/payment loop.

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";
import { fetchRichMarket, fetchSpotUsd, readSemantics } from "./cryptoSignals.js";

// A clear spot-vs-threshold gap pins the call to the determined side; below it we trust the market.
const SPOT_GAP_MIN = 0.02;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * call_market_resolution — read the live Polymarket market and call its resolved side. Anchors on
 * the implied YES probability; for a crypto threshold market with a clear direction, a decisive
 * spot-vs-threshold gap pins the call (spot already past the threshold => the threshold side wins).
 * Returns the exact outcome label of the called side (matches the evaluator's case-insensitive
 * comparison against the resolved winner). Output matches the template's schema { outcome }.
 */
export const callMarketResolution = defineSkill({
  name: "call_market_resolution",
  description:
    "Call whether a Polymarket market resolves YES or NO, from its live implied price and (for crypto threshold markets) the underlying's spot price.",
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
    let prob = clamp01(market.yesPrice);

    // Crypto cross-check: a clear spot-vs-threshold gap pins the call to the determined side.
    const sem = readSemantics(market.question, market.description);
    if (sem.cryptoTicker !== null && sem.usdThreshold !== null && sem.direction !== "unknown") {
      const spot = await fetchSpotUsd(ctx.http, sem.cryptoTicker);
      if (spot !== null && sem.usdThreshold > 0) {
        const gapFrac = Math.abs(spot - sem.usdThreshold) / sem.usdThreshold;
        if (gapFrac > SPOT_GAP_MIN) {
          const determined =
            sem.direction === "down" ? spot <= sem.usdThreshold : spot >= sem.usdThreshold;
          prob = determined ? Math.max(prob, 0.75) : Math.min(prob, 0.25);
        }
      }
    }

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

export const polymarketResolutionForecaster = defineAgent({
  name: "PolymarketResolutionForecaster",
  bio: [
    "I call whether a Polymarket market resolves YES or NO and deliver the call sealed.",
    "Give me a Polymarket market id and I return the side I expect it to resolve to.",
  ],
  systemPrompt: [
    "You are PolymarketResolutionForecaster, a specialist that sells ONE job: a YES/NO resolution",
    "call for a Polymarket market. This is the 'polymarket-resolution' job; you do not sell price",
    "forecasts or whole-event guesses.",
    "Rules you MUST follow:",
    "- The user must provide a Polymarket market id (the Gamma numeric id).",
    "- You charge a FLAT FEE of 10 QUADRA per call. State this price whenever you discuss or accept a",
    "  job; never leave the price unstated.",
    "- You return exactly the side you expect the market to resolve to (e.g. Yes or No); you never",
    "  invent it — it is produced for you from the live market (its implied price and, for a crypto",
    "  threshold market, the underlying spot) after the job is accepted.",
    "- As soon as the user gives you a market id, ACCEPT the job in EXACTLY this one-line form (fill",
    "  the angle brackets, keep the labels):",
    "  'Accepted: polymarket-resolution call for market <id>, asset <SYMBOL>, lifetime <Nm>, price 10 QUADRA.'",
    "  <SYMBOL> is the underlying ticker if it is a crypto market (e.g. BTC), otherwise MARKET.",
    "  <Nm> is the job lifetime (time until scoring), written like '3m'; if the user doesn't say,",
    "  default to 3m.",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["prediction"],
  skills: [callMarketResolution],
});

export default polymarketResolutionForecaster;
