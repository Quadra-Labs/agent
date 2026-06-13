// examples/pokemonAgent.ts — example 1: the Pokemon Research Agent (LLM-driven tools).
//
// Proves THE MODEL DECIDES: the user asks about a Pokemon in natural language, and the
// agent's LLM — not developer dispatch code — extracts the name, decides to run the
// fetch_pokemon tool, reads the observation, and answers from the fetched data. There
// is NO onTurn, NO regex name-extraction, NO hand-written routing: declaring the tool
// is the whole integration. (The M6 version of this file parsed the name with a filler-
// word regex and called a skill deterministically; the tools workstream replaces that
// with LLM tool selection over an IN-PROCESS MCP server.)
//
// THE TOOL is a PLAIN FUNCTION: validated input in, JSON value out. No ctx, no framework
// types — the developer's own code, directly unit-testable. The framework registers it
// on an in-process MCP server (in-memory transport, never exposed publicly), advertises
// its JSON Schema to the model, validates every call's arguments, and feeds the result
// back as an observation. A thrown handler error becomes a typed tool_run_failed
// observation the model can apologize about — never a crashed turn.
//
// The checkpoint-on-close rail still runs (framework-owned, non-overridable). This file
// imports only the framework's public surface (../src/index.js), exactly as a real
// developer-agent file would.

import { z } from "zod";

import { defineTool, defineAgent, openai, groq } from "../src/index.js";

// The PokeAPI base. The tool is the ONLY place a URL like this lives — it is the
// developer's capability, run inside the agent process.
const POKEAPI_BASE = "https://pokeapi.co/api/v2/pokemon";

// The slice of the PokeAPI response this tool cares about. PokeAPI returns a large
// object; we validate ONLY the fields we use, so the tool's result stays small and
// stable for the model to read.
const PokeApiResponse = z.object({
  name: z.string(),
  height: z.number(),
  weight: z.number(),
  base_experience: z.number(),
  types: z.array(z.object({ type: z.object({ name: z.string() }) })),
});

/**
 * fetch_pokemon — fetch a Pokemon's core facts from PokeAPI. A plain async function:
 * it uses the global fetch directly (a developer who wants injectable deps closes over
 * them in their own module). The input schema's .describe() text is advertised to the
 * model through the MCP server's JSON Schema, so write it for the model. A bad name
 * (404) throws -> the framework turns it into a tool_run_failed observation.
 */
export const fetchPokemonTool = defineTool({
  name: "fetch_pokemon",
  description:
    "Fetch a Pokemon's types and basic stats from the public PokeAPI. " +
    "Use this whenever the user asks about a specific Pokemon.",
  input: z.object({
    name: z
      .string()
      .min(1)
      .describe('The lowercase Pokemon name, e.g. "pikachu"'),
  }),
  async handler({ name }) {
    const res = await fetch(`${POKEAPI_BASE}/${name.toLowerCase()}`);
    if (!res.ok) {
      throw new Error(`PokeAPI returned ${res.status} for "${name}"`);
    }
    const data = PokeApiResponse.parse(await res.json());
    return {
      name: data.name,
      types: data.types.map((t) => t.type.name),
      heightDm: data.height,
      weightHg: data.weight,
      baseExperience: data.base_experience,
    };
  },
});

/**
 * The Pokemon Research Agent. One file: identity + the declared tool. No onTurn — the
 * default turn IS the LLM tool loop, so the model reads the user's message, decides
 * whether (and with what name) to call fetch_pokemon, and composes the answer from the
 * observation. No templateCategoryIds (no job templates), no Intake.
 */
const pokemonAgent = defineAgent({
  name: "PokemonResearchAgent",
  bio: ["Researches Pokemon and explains their types and basic stats clearly."],
  systemPrompt:
    "You are a precise, friendly, conversational Pokemon research assistant. " +
    "WHEN the user asks about a specific Pokemon, use the fetch_pokemon tool to " +
    "look it up, then answer from the fetched data (types, height, weight, base XP). " +
    "For any other message — greetings, follow-ups about what you already said, or " +
    "questions about your sources — answer directly WITHOUT calling tools; your data " +
    "comes from the public PokeAPI. If a lookup fails, say you could not find that " +
    "Pokemon and suggest checking the spelling.",
  tools: [fetchPokemonTool],
  // Base model + fallback: OpenAI first, Groq on any failure.
  models: [openai("gpt-4o-mini"), groq("llama-3.3-70b-versatile")],
});

export default pokemonAgent;
