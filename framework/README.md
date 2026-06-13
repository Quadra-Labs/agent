# @sui-walrus/agent-framework

Build an agent in one `.ts` file. You declare an identity, the tools the model may
call, and a model chain; the framework runs the turn loop and a sealed
checkpoint-on-close memory rail over the ElizaOS runtime. You never write dispatch
code — the model decides when to call your tools.

## Quickstart

A complete agent is a single file that imports only the public surface (`./src/index.ts`):

```ts
import { z } from "zod";
import { defineTool, defineAgent, openai, groq } from "../src/index.js";

const fetchPokemon = defineTool({
  name: "fetch_pokemon",
  description: "Fetch a Pokemon's types and stats. Use when asked about a Pokemon.",
  input: z.object({ name: z.string().min(1).describe('lowercase name, e.g. "pikachu"') }),
  async handler({ name }) {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${name.toLowerCase()}`);
    if (!res.ok) throw new Error(`PokeAPI ${res.status} for "${name}"`);
    return await res.json();
  },
});

export default defineAgent({
  name: "PokemonResearchAgent",
  bio: ["Researches Pokemon and explains their types and stats."],
  systemPrompt: "Use fetch_pokemon when the user names a Pokemon; otherwise answer directly.",
  tools: [fetchPokemon],
  models: [openai("gpt-4o-mini"), groq("llama-3.3-70b-versatile")], // base + fallback
});
```

A tool is a plain function: validated input in, JSON value out. No framework types in
your handler, so it is directly unit-testable. A thrown handler error becomes a typed
`tool_run_failed` observation the model can recover from — never a crashed turn.

## Run the examples

```sh
npm run chat:example                 # the Pokemon agent, real runtime
npm run chat:btc                     # the BTC research agent
npm run chat:example -- --user alice # per-user memory (recall on relaunch)
npm run chat:example -- --sandbox    # keyless: in-memory stub runtime, rails only
npm run chat:example -- --verbose    # print every prompt the model sees
```

Real mode needs `GROQ_API_KEY` (or your chosen provider key) in `app/.env` — the
host runtime's LLM provider is plugin-groq, and tool decisions need a real model. The
framework itself is provider-agnostic and never sees the key. `--sandbox` needs no keys:
it boots an in-memory stub so you can exercise the machinery offline (replies are canned
because the stub model cannot decide to call tools).

In-REPL: `/close` writes a real checkpoint, `/help`, `/exit`.

## Layout

```
framework/
├── examples/        runnable example agents + the chat.ts host (+ stubRuntime sandbox)
└── src/
    ├── index.ts     the public barrel — the only entry point you import
    ├── http.ts errors.ts models.ts   shared, cross-cluster building blocks
    ├── skills/      defineSkill, skillRunner, compileSkill (deterministic ctx.callSkill)
    ├── tools/       defineTool, toolServer, toolLoop, toolPrompt, toolErrors (LLM-decided)
    └── session/     defineAgent, runAgent + the sealed rail (state, loop, close)
```

Skills are deterministic functions you dispatch yourself (`ctx.callSkill`); tools are
plain functions the model decides to call over an in-process MCP server. Both are
optional — an agent can use either, both, or neither.
