// Standalone ElizaOS runtime boot for the demo. Mirrors the proven phase0 spike
// (phase0/spike/eliza_standalone/eliza_standalone.mjs):
//   AgentRuntime + plugin-sql + plugin-groq, manual migration bootstrap,
//   config via character.settings (NOT process.env), model overrides, PGlite dir.
//
// EMBEDDING NOTE: plugin-groq does not register a TEXT_EMBEDDING handler, and a
// future semantic-recall path (Task 2) may call one. plugin-sql's createMemory
// only writes/searches an embedding when one is present, so plain chat writes do
// not strictly need it -- but to keep memory writes and any embedding lookups
// working WITHOUT a second API key, we register a deterministic, fully local
// embedding handler here: a fixed-dimension vector hashed from the input text.
// It is NOT semantically meaningful; it exists only so the runtime never depends
// on an external embedding service. No network, no key.

import { AgentRuntime, ModelType, stringToUuid } from "@elizaos/core";
import type { IAgentRuntime, IDatabaseAdapter } from "@elizaos/core";
import groqPlugin from "@elizaos/plugin-groq";
import sqlPlugin, { createDatabaseAdapter } from "@elizaos/plugin-sql";
import type { DemoConfig } from "./config.js";

// Fixed embedding width. 384 matches plugin-sql's smallest supported vector dim
// (VECTOR_DIMS.SMALL -> dim384), so a stored vector lands in a real column.
const EMBEDDING_DIM = 384;

// Stable agent identity for the demo. Deterministic so the same DB is reused.
export const DEMO_AGENT_NAME = "WalrusDemoAgent";

export interface DemoRuntime {
  readonly runtime: IAgentRuntime;
  /** Best-effort shutdown. PGlite WASM teardown may print a cosmetic libuv
   *  assertion on Windows AFTER work completes (exit code stays 0); that is
   *  known noise, not a failure. */
  readonly stop: () => Promise<void>;
}

// Minimal shape of the plugin object that runPluginMigrations expects (name +
// optional schema). Matches IDatabaseAdapter.runPluginMigrations' parameter type.
// Both sqlPlugin and groqPlugin satisfy this at runtime.
type SchemaValue = string | number | boolean | null | Record<string, unknown>;
type SchemaPlugin = { name: string; schema?: Record<string, SchemaValue> };

/**
 * Deterministic local embedding: lowercase the text, hash each token into one of
 * EMBEDDING_DIM buckets, L2-normalize. Same text -> same vector, no external API.
 * Empty/missing text yields a zero vector (still a valid fixed-width array).
 */
function localEmbedding(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = (hash >>> 0) % EMBEDDING_DIM;
    vec[bucket] += 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

function extractEmbeddingText(params: unknown): string {
  if (typeof params === "string") return params;
  if (params && typeof params === "object" && "text" in params) {
    const value = (params as { text?: unknown }).text;
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * Build and initialize a standalone demo runtime. The returned runtime has the
 * DB adapter registered, migrations applied, plugins wired, and a local
 * embedding handler available. Throws if boot fails.
 */
export async function createDemoRuntime(config: DemoConfig): Promise<DemoRuntime> {
  const agentId = stringToUuid(DEMO_AGENT_NAME);

  // Config goes in character.settings: plugin-groq reads via runtime.getSetting,
  // which resolves character.settings, NOT process.env (memory: elizaos-standalone).
  const character = {
    name: DEMO_AGENT_NAME,
    bio: ["A standalone demo agent backed by local chat memory and Walrus."],
    plugins: ["@elizaos/plugin-sql", "@elizaos/plugin-groq"],
    settings: {
      GROQ_LARGE_MODEL: config.groqLargeModel,
      GROQ_SMALL_MODEL: config.groqSmallModel,
      secrets: { GROQ_API_KEY: config.groqApiKey },
    },
  };

  const runtime = new AgentRuntime({
    character,
    agentId,
    // Plugin objects passed directly (no registry resolution). SQL first so the
    // DB adapter type is known before initialize().
    plugins: [sqlPlugin, groqPlugin],
    settings: { GROQ_API_KEY: config.groqApiKey },
  });

  // Register the deterministic local embedding handler with a high priority so it
  // wins over any default. Provider name is namespaced to the demo.
  runtime.registerModel(
    ModelType.TEXT_EMBEDDING,
    async (_rt: IAgentRuntime, params: Record<string, unknown>) =>
      localEmbedding(extractEmbeddingText(params)),
    "demo-local-embedding",
    100,
  );

  // Bare-runtime DB bootstrap (the CLI normally does this):
  //   1. create the embedded PGlite adapter
  //   2. run plugin migrations to BUILD the schema (else the "agents" table is
  //      missing -- runPluginMigrations is optional on the interface but present
  //      on the plugin-sql adapter at runtime)
  //   3. register the adapter, then initialize the runtime.
  const adapter: IDatabaseAdapter = createDatabaseAdapter({ dataDir: config.dbDir }, agentId);
  await adapter.init();
  const schemaPlugins: SchemaPlugin[] = [
    sqlPlugin as unknown as SchemaPlugin,
    groqPlugin as unknown as SchemaPlugin,
  ];
  await adapter.runPluginMigrations?.(schemaPlugins);
  runtime.registerDatabaseAdapter(adapter);
  await runtime.initialize();

  const stop = async (): Promise<void> => {
    if (typeof runtime.stop === "function") {
      try {
        await runtime.stop();
      } catch {
        // best-effort; PGlite teardown noise on Windows is expected
      }
    }
  };

  return { runtime, stop };
}
