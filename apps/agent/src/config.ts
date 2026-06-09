// Pure configuration loading for the agent app. Reads from process.env only;
// performs no file or network I/O. The boot script loads apps/agent/.env into
// process.env first (tsx does not auto-load it), so by the time loadAgentConfig
// runs the values are already present.
//
// Config flows into character.settings (NOT process.env) at runtime: plugin-groq
// and the Walrus service read via runtime.getSetting, which resolves
// character.settings (memory: elizaos-standalone-gotchas).
//
// A3 Walrus DECISION (locked): the SDK path with a funded testnet signer. The
// signer secret is OPTIONAL here -- booting and resolving the walrus/memwal
// services must NOT require it (a missing signer yields a read-only Walrus
// service; store() would later return config_error). The signer secret is read
// but NEVER logged.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Defaults proven to work in this project (see phase0 spike + PLAN.md).
const DEFAULT_LARGE_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_SMALL_MODEL = "llama-3.1-8b-instant";
const DEFAULT_WALRUS_NETWORK = "testnet";
const DEFAULT_WALRUS_EPOCHS = "3";

// Default session-length checkpoint gate (A3 Task 4). Once a session reaches this
// many turns, the session-lifecycle caller rolls it into a checkpoint (NOT a
// per-message evaluator — that would store a blob per turn and burn gas). A modest
// default keeps checkpoints meaningful without checkpointing trivially short chats.
const DEFAULT_SESSION_TURN_LIMIT = 20;

export interface AgentConfig {
  /** Groq API key. Required for the LLM. */
  readonly groqApiKey: string;
  /** Large text model id (overrides plugin-groq's decommissioned default). */
  readonly groqLargeModel: string;
  /** Small text model id. */
  readonly groqSmallModel: string;
  /** PGlite data directory (the local "SQLite" DB) under apps/agent/.eliza-db. */
  readonly dbDir: string;
  /** Walrus network. A3 uses testnet (the only value the service accepts). */
  readonly walrusNetwork: string;
  /** Walrus Sui RPC URL. Empty string -> the service derives the testnet default. */
  readonly walrusSuiRpcUrl: string;
  /** Walrus storage epochs (Walrus testnet minimum is 3). */
  readonly walrusEpochs: string;
  /**
   * OPTIONAL funded Sui testnet signer secret (suiprivkey... or base64 32-byte
   * seed). Absent -> Walrus boots read-only. NEVER logged.
   */
  readonly walrusSignerKey: string | undefined;
  /**
   * Session-length checkpoint gate (A3 Task 4): once a session reaches this many
   * turns, the lifecycle caller checkpoints it. Always a positive integer (a
   * non-positive / unparseable override falls back to the default).
   */
  readonly sessionTurnLimit: number;
}

// Parse a positive-integer setting, falling back to `fallback` for a missing,
// blank, non-numeric, or non-positive value. Keeps a misconfigured limit from
// disabling the gate or forcing a per-turn checkpoint.
function readPositiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = readTrimmed(env, key);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the typed agent config from the environment. The only hard requirement is
 * GROQ_API_KEY; everything else has a safe default or is optional. Pure aside from
 * reading env. The signer secret is optional by design (boot must not need it).
 */
export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const groqApiKey = (env.GROQ_API_KEY ?? "").trim();
  if (groqApiKey.length === 0) {
    throw new Error(
      "GROQ_API_KEY is required. Copy apps/agent/.env.example to apps/agent/.env and set your Groq key.",
    );
  }

  // apps/agent/.eliza-db lives one level up from src/.
  const appRoot = resolve(here, "..");

  return {
    groqApiKey,
    groqLargeModel: readTrimmed(env, "GROQ_LARGE_MODEL") ?? DEFAULT_LARGE_MODEL,
    groqSmallModel: readTrimmed(env, "GROQ_SMALL_MODEL") ?? DEFAULT_SMALL_MODEL,
    dbDir: resolve(appRoot, ".eliza-db"),
    walrusNetwork: readTrimmed(env, "WALRUS_NETWORK") ?? DEFAULT_WALRUS_NETWORK,
    walrusSuiRpcUrl: readTrimmed(env, "SUI_RPC_URL") ?? "",
    walrusEpochs: readTrimmed(env, "WALRUS_EPOCHS") ?? DEFAULT_WALRUS_EPOCHS,
    walrusSignerKey: readTrimmed(env, "WALRUS_SIGNER_KEY"),
    sessionTurnLimit: readPositiveInt(
      env,
      "MEMWAL_SESSION_TURN_LIMIT",
      DEFAULT_SESSION_TURN_LIMIT,
    ),
  };
}
