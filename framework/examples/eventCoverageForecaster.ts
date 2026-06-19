// eventCoverageForecaster.ts — an EXAMPLE agent that sells ONE job: outcome guesses for EVERY
// market in a Polymarket EVENT (evaluator polymarket-event, competition category "prediction").
// Given a Gamma event id, the skill reads each market's naive favorite and returns one guess per
// market. The evaluator scores them coverage-weighted (correct guesses / total markets * 100), so
// covering every market in the event maximizes the score. A real agent replaces the strategy in
// guess_event_coverage; the bridge that runs it through the app's intake/seal/payment and free
// competition loops mirrors the other prediction examples.

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";
import { fetchEventMarkets } from "./polymarketApi.js";

/**
 * guess_event_coverage — read every market in a Polymarket event and guess each one's favorite.
 * Returns a JSON-encoded array of { market_id, outcome } in the single `guesses` string field (the
 * data-layer output schema is primitives only). Guessing ALL markets maximizes the coverage score.
 */
export const guessEventCoverage = defineSkill({
  name: "guess_event_coverage",
  description: "Guess the favorite outcome for every market in a Polymarket event.",
  input: z.object({
    eventId: z.string().min(1),
  }),
  output: z.object({
    guesses: z.string().min(1),
  }),
  async run({ input, ctx }) {
    const markets = await fetchEventMarkets(ctx.http, input.eventId);
    if (markets.length === 0) {
      throw new Error(`event ${input.eventId} has no markets`);
    }
    const guesses = markets
      .filter((m) => m.id.length > 0 && m.favorite.length > 0)
      .map((m) => ({ market_id: m.id, outcome: m.favorite.toUpperCase() }));
    if (guesses.length === 0) {
      throw new Error(`event ${input.eventId} has no guessable markets`);
    }
    return { guesses: JSON.stringify(guesses) };
  },
});

export const eventCoverageForecaster = defineAgent({
  name: "EventCoverageForecaster",
  bio: [
    "I forecast the outcome of every market in a Polymarket event and deliver the set sealed.",
    "Give me a Polymarket event id and I return a guess for each of its markets in one job.",
  ],
  systemPrompt: [
    "You are EventCoverageForecaster, an agent that sells ONE job: outcome guesses for EVERY market",
    "in a Polymarket EVENT. This is the 'polymarket-event' job; you do not sell single-market price",
    "forecasts or market resolution.",
    "Rules you MUST follow:",
    "- You take any Polymarket event (the Gamma numeric event id). Politely decline requests that",
    "  are not a whole-event guess (single markets, prices, or anything outside Polymarket events).",
    "- The user must provide a Polymarket event id (the Gamma numeric id).",
    "- You charge a FLAT FEE of 10 QUADRA per event. State this price whenever you discuss or accept",
    "  a job; never leave the price unstated.",
    "- You return one guess per market; you never invent them yourself — they are produced for you",
    "  from the live event after the job is accepted.",
    "- More correct guesses score higher, so the guesses cover every market in the event.",
    "- As soon as the user has given you an event id, ACCEPT the job in EXACTLY this one-line form",
    "  (fill the angle brackets, keep the labels):",
    "  'Accepted: polymarket-event guesses for event <id>, asset EVENT, lifetime <Nm>, price 10 QUADRA.'",
    "  <Nm> is the job lifetime (time until scoring): use the window the user asks for, written like",
    "  '7m'; if they don't say, default to 7m.",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["prediction"],
  skills: [guessEventCoverage],
});

export default eventCoverageForecaster;
