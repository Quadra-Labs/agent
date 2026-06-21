// registry.ts — the example agents you can serve over HTTP / expose via a tunnel, keyed by a
// short name. Each entry mirrors the matching `example:*` interactive run script: the agent's
// character paired with the SAME produce hook that runner uses (a skill producer, or none for
// the scoreless seo-article, where the default LLM producer writes the result). A developer
// serving their OWN framework agent follows this exact shape: { character, produce? }.
//
// Shared CLI helpers (loadAppEnv, parseAgentName) live here so serve.ts and tunnel.ts stay tiny.

import { fileURLToPath } from "node:url";

import { makeSkillProducer } from "../src/index.js";
import type { AgentCharacter } from "../../app/src/character/character.js";
import type { ProduceHook } from "../../app/src/jobs/jobResult.js";

import { priceRangeAgent } from "./priceRangeAgent.js";
import { ethPriceBandAgent } from "./ethPriceBandAgent.js";
import { solPriceBandAgent } from "./solPriceBandAgent.js";
import { btcUpDownAgent } from "./btcUpDownAgent.js";
import { polymarketPriceAgent } from "./polymarketPriceAgent.js";
import { polymarketResolutionAgent } from "./polymarketResolutionAgent.js";
import { polymarketEventAgent } from "./polymarketEventAgent.js";
import { seoArticleAgent } from "./seoArticleAgent.js";

export interface ExampleEntry {
  readonly character: AgentCharacter;
  /** The result producer after payment. Omitted for scoreless agents (default LLM producer). */
  readonly produce?: ProduceHook;
}

// The set of example agents exposable as a service. Keep these in lockstep with the
// `example:*` scripts in package.json so the HTTP and interactive forms behave identically.
export const EXAMPLE_AGENTS: Readonly<Record<string, ExampleEntry>> = {
  "price-range": {
    character: priceRangeAgent.character,
    produce: makeSkillProducer(priceRangeAgent.skills),
  },
  "eth-price-band": {
    character: ethPriceBandAgent.character,
    produce: makeSkillProducer(ethPriceBandAgent.skills),
  },
  "sol-price-band": {
    character: solPriceBandAgent.character,
    produce: makeSkillProducer(solPriceBandAgent.skills),
  },
  "btc-up-down": {
    character: btcUpDownAgent.character,
    produce: makeSkillProducer(btcUpDownAgent.skills),
  },
  "poly-price": {
    character: polymarketPriceAgent.character,
    produce: makeSkillProducer(polymarketPriceAgent.skills),
  },
  "poly-resolution": {
    character: polymarketResolutionAgent.character,
    produce: makeSkillProducer(polymarketResolutionAgent.skills),
  },
  "poly-event": {
    character: polymarketEventAgent.character,
    produce: makeSkillProducer(polymarketEventAgent.skills),
  },
  // Scoreless: no produce hook — the default LLM producer writes the article from the brief.
  "seo-article": {
    character: seoArticleAgent.character,
  },
};

export function exampleNames(): string[] {
  return Object.keys(EXAMPLE_AGENTS);
}

// Load the app's .env (these scripts run from agent/framework, so the app .env is two dirs up).
export function loadAppEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader(fileURLToPath(new URL("../../app/.env", import.meta.url)));
  } catch {
    // No .env — rely on whatever is already in the environment.
  }
}

// Parse `--agent <name>` (alias `-a`). Returns undefined if absent.
export function parseAgentName(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if ((argv[i] === "--agent" || argv[i] === "-a") && i + 1 < argv.length) return argv[i + 1];
  }
  return undefined;
}

// Resolve a name to its entry, or print the available names and exit (CLI helper).
export function resolveExample(name: string | undefined): ExampleEntry {
  if (name === undefined) {
    console.error(`--agent <name> is required. Available: ${exampleNames().join(", ")}`);
    process.exit(1);
  }
  const entry = EXAMPLE_AGENTS[name];
  if (entry === undefined) {
    console.error(`Unknown agent "${name}". Available: ${exampleNames().join(", ")}`);
    process.exit(1);
  }
  return entry;
}
