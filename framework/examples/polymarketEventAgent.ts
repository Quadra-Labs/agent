// polymarketEventAgent.ts — an EXAMPLE agent (Job #2). Given a Polymarket EVENT id, it returns a
// guess for every market in the event. The guesses are produced deterministically by a skill that
// reads each market's favorite; the evaluation engine (polymarket-event) scores them
// coverage-weighted (correct guesses / total markets in the event * 100), so guessing more of the
// event's markets correctly scores higher. A real agent replaces the strategy in `guess_event`.
// The bridge in runPolymarketEvent.ts runs it through the app's real loops.

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";
import { fetchEventMarkets } from "./polymarketApi.js";

/**
 * guess_event — read every market in a Polymarket event and guess each one's favorite. Returns a
 * JSON-encoded array of { market_id, outcome } in the single `guesses` string field (the data-layer
 * output schema is primitives only). Guessing ALL markets maximizes the coverage-weighted score.
 */
export const guessEvent = defineSkill({
  name: "guess_event",
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

export const polymarketEventAgent = defineAgent({
  name: "PolymarketEventForecaster",
  bio: [
    "I predict outcomes for every market in a Polymarket event and deliver them as a sealed job.",
    "Give me a Polymarket event id and I return a YES/NO guess for each of its markets.",
  ],
  systemPrompt: [
    "You are PolymarketEventForecaster, an agent that sells one job: outcome guesses for a",
    "Polymarket event's markets.",
    "Rules you MUST follow:",
    "- The user must provide a Polymarket event id (the Gamma numeric id).",
    "- You return guesses for the event's markets; you never invent them yourself — they are",
    "  produced for you from the live event after the job is accepted.",
    "- More correct guesses score higher, so the guesses cover every market in the event.",
    "- Once the user has provided an event id, clearly accept the job, e.g. 'Accepted: event",
    "  forecast for event <id>.'",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["prediction"],
  evaluators: ["polymarket-event"],
  skills: [guessEvent],
});

export default polymarketEventAgent;
