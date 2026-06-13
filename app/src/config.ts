// Pure configuration loading for the agent app: reads process.env only, no I/O. Config
// flows into character.settings (NOT process.env) at runtime — plugins read via
// runtime.getSetting (memory: elizaos-standalone-gotchas). Walrus uses the SDK path; the
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

// Open-mode testnet Seal key servers, read on-chain in the P0c spike (NOT assumed).
// Used to encrypt the job result under the quadra::job_access policy. Both run in
// Open mode, so basic testnet encryption needs no API key (see phase0/spike/P0c-seal.md).
const DEFAULT_SEAL_KEY_SERVER_IDS = [
  "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98",
  "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
];

// Seal threshold: how many of the configured key servers must return a key share.
// With two open-mode servers, a threshold of 1 keeps encryption/decryption working if
// either server is reachable (the spike's resilience choice). Overridable via env.
const DEFAULT_SEAL_THRESHOLD = 1;

// Default session-length checkpoint gate (A3 Task 4). Once a session reaches this
// many turns, the session-lifecycle caller rolls it into a checkpoint (NOT a
// per-message evaluator — that would store a blob per turn and burn gas). A modest
// default keeps checkpoints meaningful without checkpointing trivially short chats.
const DEFAULT_SESSION_TURN_LIMIT = 20;

export interface AgentConfig {
  /** Groq API key. OPTIONAL: powers the runtime's own model; agents with a provider
   *  chain do not need it. Absent -> runtime model calls fail (chain calls do not). */
  readonly groqApiKey: string | undefined;
  /** Large text model id (overrides plugin-groq's decommissioned default). */
  readonly groqLargeModel: string;
  /** Small text model id. */
  readonly groqSmallModel: string;
  /** PGlite data directory (the local "SQLite" DB) under app/.eliza-db. */
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
  /**
   * OPTIONAL deployed `quadra` package id (0x...), the Seal `packageId` namespace
   * the job result is encrypted under. Absent -> the job-result Seal write is
   * skipped (the agent still constructs the Intake notification). This is the gate
   * between "encrypt+store proven" and "decrypt-through-policy live": until the real
   * deployed package id (and matching on-chain job_ids) are set, encryption runs but
   * the resulting ciphertext cannot be decrypted through the live seal_approve.
   */
  readonly sealPackageId: string | undefined;
  /** Seal key server object ids (open-mode testnet). Defaults to the P0c spike pair. */
  readonly sealKeyServerIds: readonly string[];
  /** Seal TSS threshold (how many key servers must return a key share). */
  readonly sealThreshold: number;
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

// Parse a comma-separated setting into a trimmed, non-empty string list, falling back
// to `fallback` when the setting is absent or yields no non-empty entries.
function readCsv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: readonly string[],
): readonly string[] {
  const raw = readTrimmed(env, key);
  if (raw === undefined) return fallback;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : fallback;
}

/**
 * Build the typed agent config from the environment. EVERY key is optional: GROQ
 * powers the runtime's own model (the character CLI and chain-less agents); agents
 * with a provider chain need none of it. Pure aside from reading env.
 */
export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  // app/.eliza-db lives one level up from src/.
  const appRoot = resolve(here, "..");

  return {
    groqApiKey: readTrimmed(env, "GROQ_API_KEY"),
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
    sealPackageId: readTrimmed(env, "SEAL_PACKAGE_ID"),
    sealKeyServerIds: readCsv(env, "SEAL_KEY_SERVER_IDS", DEFAULT_SEAL_KEY_SERVER_IDS),
    sealThreshold: readPositiveInt(env, "SEAL_THRESHOLD", DEFAULT_SEAL_THRESHOLD),
  };
}
