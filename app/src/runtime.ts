// runtime.ts — standalone ElizaOS runtime boot for the agent app: AgentRuntime + manual
// migration bootstrap + config via character.settings (NOT process.env). Plugin order
// matters: [sql, groq, walrus, memwal] — SQL first (DB adapter known before
// initialize()); walrus before memwal (MemWal -> Walrus dependency). Registers a
// deterministic LOCAL embedding handler so memory writes work without a second API key.

import { AgentRuntime, ModelType, stringToUuid } from "@elizaos/core";
import type { IAgentRuntime, IDatabaseAdapter } from "@elizaos/core";
import groqPlugin from "@elizaos/plugin-groq";
import sqlPlugin, { createDatabaseAdapter } from "@elizaos/plugin-sql";

import { walrusPluginWithSigner } from "./walrusPluginWithSigner.js";
import { memwalPlugin } from "../../plugins/plugin-memwal/src/index.js";
import type { AgentConfig } from "./config.js";
import { DEFAULT_CHARACTER, type AgentCharacter } from "./character.js";

// Fixed embedding width. 384 matches plugin-sql's smallest supported vector dim
// (VECTOR_DIMS.SMALL -> dim384), so a stored vector lands in a real column.
const EMBEDDING_DIM = 384;

// Stable agent identity for callers that do not pass a custom character (every
// proof). Derived from DEFAULT_CHARACTER so the default name/bio is single-sourced.
// Deterministic so the same DB is reused across boots.
export const AGENT_NAME = DEFAULT_CHARACTER.name;

export interface AgentRuntimeHandle {
  readonly runtime: IAgentRuntime;
  /** Best-effort shutdown. PGlite WASM teardown may print a cosmetic libuv
   *  assertion on Windows AFTER work completes (exit code stays 0); known noise. */
  readonly stop: () => Promise<void>;
}

// Minimal shape runPluginMigrations expects (name + optional schema). All four
// plugins satisfy this at runtime; plugins WITHOUT a schema simply no-op.
type SchemaValue = string | number | boolean | null | Record<string, unknown>;
type SchemaPlugin = { name: string; schema?: Record<string, SchemaValue> };

// The service serviceTypes this app guarantees are LIVE after boot. MemWal
// composes Walrus, so both must resolve for the agent to be usable.
const REQUIRED_SERVICE_TYPES = ["walrus", "memwal"] as const;

// Per-service readiness wait. AgentRuntime starts plugin services ASYNCHRONOUSLY
// after initialize() resolves (registerService awaits the init promise, then calls
// the static start()), so getService() returns null for a tick right after
// initialize(). The runtime exposes getServiceLoadPromise(type) which resolves
// when that service registers; awaiting it makes "service live at boot" true for
// EVERY caller, not just the smoke test. Structural-typed because the method is
// not on the published IAgentRuntime surface.
type ServiceLoadAwaiter = {
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown> | undefined;
};

// Boot-time cap so a service that never registers fails loudly instead of hanging.
const SERVICE_READY_TIMEOUT_MS = 30000;

async function awaitServicesReady(runtime: IAgentRuntime): Promise<void> {
  const awaiter = runtime as unknown as ServiceLoadAwaiter;
  for (const serviceType of REQUIRED_SERVICE_TYPES) {
    // Already live -> nothing to await.
    if (runtime.getService(serviceType)) continue;
    const loadPromise = awaiter.getServiceLoadPromise?.(serviceType);
    if (loadPromise === undefined) {
      throw new Error(
        `runtime cannot await service "${serviceType}" (no getServiceLoadPromise)`,
      );
    }
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`service "${serviceType}" did not become live in time`)),
        SERVICE_READY_TIMEOUT_MS,
      );
    });
    await Promise.race([loadPromise, timeout]);
  }
}

/**
 * Deterministic local embedding: lowercase the text, hash each token into one of
 * EMBEDDING_DIM buckets, L2-normalize. Same text -> same vector, no external API.
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
 * Build and initialize the standalone agent runtime with all four plugins. The
 * returned runtime has the DB adapter registered, migrations applied, plugins
 * wired, and a local embedding handler available. Throws if boot fails.
 *
 * Config goes in character.settings: plugin-groq and the Walrus service read via
 * runtime.getSetting, which resolves character.settings, NOT process.env
 * (memory: elizaos-standalone-gotchas). The signer secret rides in settings as a
 * STRING under WALRUS_SIGNER_KEY and is normalized inside the Walrus service; it
 * is OPTIONAL (absent -> read-only Walrus) and is NEVER logged.
 */
export async function createAgentRuntime(
  config: AgentConfig,
  character: AgentCharacter = DEFAULT_CHARACTER,
): Promise<AgentRuntimeHandle> {
  // The agent identity (and the DB partition) keys off the character name. The
  // default character reproduces AGENT_NAME, so one-arg callers are unchanged; a
  // custom character boots a DISTINCT identity (and resolves its own checkpoints).
  const agentId = stringToUuid(character.name);

  // plugin-groq THROWS at init without a key (verified live), so a missing key gets a
  // boot-only placeholder (precedent: demo/src/smoke.ts). Real groq CALLS would 401;
  // an agent with a provider chain never makes one.
  const effectiveGroqKey = config.groqApiKey ?? "gsk_boot_only_placeholder";

  // Only set WALRUS_SIGNER_KEY in settings when present, so its absence is a clean
  // "undefined" the service treats as read-only. The secret is never logged.
  const walrusSettings: Record<string, string> = {
    WALRUS_NETWORK: config.walrusNetwork,
    WALRUS_EPOCHS: config.walrusEpochs,
    ...(config.walrusSuiRpcUrl.length > 0 ? { SUI_RPC_URL: config.walrusSuiRpcUrl } : {}),
    ...(config.walrusSignerKey !== undefined
      ? { WALRUS_SIGNER_KEY: config.walrusSignerKey }
      : {}),
  };

  const elizaCharacter = {
    name: character.name,
    bio: [...character.bio],
    plugins: [
      "@elizaos/plugin-sql",
      "@elizaos/plugin-groq",
      "plugin-walrus",
      "plugin-memwal",
    ],
    settings: {
      GROQ_LARGE_MODEL: config.groqLargeModel,
      GROQ_SMALL_MODEL: config.groqSmallModel,
      ...walrusSettings,
      secrets: { GROQ_API_KEY: effectiveGroqKey },
    },
  };

  const runtime = new AgentRuntime({
    character: elizaCharacter,
    agentId,
    // Plugin objects passed directly (no registry resolution). SQL first; Walrus
    // before MemWal so MemwalService can resolve the live WalrusService.
    plugins: [sqlPlugin, groqPlugin, walrusPluginWithSigner, memwalPlugin],
    settings: { GROQ_API_KEY: effectiveGroqKey },
  });

  // Deterministic local embedding handler, high priority so it wins over defaults.
  runtime.registerModel(
    ModelType.TEXT_EMBEDDING,
    async (_rt: IAgentRuntime, params: Record<string, unknown>) =>
      localEmbedding(extractEmbeddingText(params)),
    "agent-local-embedding",
    100,
  );

  // Bare-runtime DB bootstrap (the CLI normally does this):
  //   1. create the embedded PGlite adapter
  //   2. run plugin migrations to BUILD the schema (else core tables are missing).
  //      Schema-less plugins (walrus/memwal) no-op here.
  //   3. register the adapter, then initialize the runtime.
  const adapter: IDatabaseAdapter = createDatabaseAdapter({ dataDir: config.dbDir }, agentId);
  await adapter.init();
  const schemaPlugins: SchemaPlugin[] = [
    sqlPlugin as unknown as SchemaPlugin,
    groqPlugin as unknown as SchemaPlugin,
    walrusPluginWithSigner as unknown as SchemaPlugin,
    memwalPlugin as unknown as SchemaPlugin,
  ];
  await adapter.runPluginMigrations?.(schemaPlugins);
  runtime.registerDatabaseAdapter(adapter);
  await runtime.initialize();

  // initialize() resolving does NOT mean plugin services have started (they start
  // asynchronously just after). Block until the Walrus and MemWal services are
  // live so the returned handle satisfies the boot contract for every caller.
  await awaitServicesReady(runtime);

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
