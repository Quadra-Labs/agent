// Pure configuration loading for the demo. Reads from process.env only; performs
// no file or network I/O. Throws a clear error if a required value is missing.
//
// The demo deliberately needs ONLY a Groq key. Walrus is wallet-free (public
// publisher) and the model overrides cover the decommissioned plugin-groq default.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Defaults proven to work in this project (see phase0 spike + PLAN.md).
const DEFAULT_LARGE_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_SMALL_MODEL = "llama-3.1-8b-instant";
const DEFAULT_PUBLISHER = "https://publisher.walrus-testnet.walrus.space";
const DEFAULT_AGGREGATOR = "https://aggregator.walrus-testnet.walrus.space";

export interface DemoConfig {
  /** Groq API key. Required for the LLM. */
  readonly groqApiKey: string;
  /** Large text model id (overrides plugin-groq's decommissioned default). */
  readonly groqLargeModel: string;
  /** Small text model id. */
  readonly groqSmallModel: string;
  /** PGlite data directory (the local "SQLite" DB) under demo/.eliza-db. */
  readonly dbDir: string;
  /** Walrus testnet HTTP publisher base URL (wallet-free writes). */
  readonly walrusPublisherUrl: string;
  /** Walrus testnet HTTP aggregator base URL (reads). */
  readonly walrusAggregatorUrl: string;
}

function readTrimmed(key: string): string | undefined {
  const raw = process.env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the typed demo config from the environment. The only hard requirement is
 * GROQ_API_KEY; everything else has a safe default. Pure aside from reading env.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const groqApiKey = (env.GROQ_API_KEY ?? "").trim();
  if (groqApiKey.length === 0) {
    throw new Error(
      "GROQ_API_KEY is required. Copy demo/.env.example to demo/.env and set your Groq key.",
    );
  }

  // demo/.eliza-db lives one level up from src/.
  const demoRoot = resolve(here, "..");

  return {
    groqApiKey,
    groqLargeModel: readTrimmed("GROQ_LARGE_MODEL") ?? DEFAULT_LARGE_MODEL,
    groqSmallModel: readTrimmed("GROQ_SMALL_MODEL") ?? DEFAULT_SMALL_MODEL,
    dbDir: resolve(demoRoot, ".eliza-db"),
    walrusPublisherUrl: readTrimmed("WALRUS_PUBLISHER_URL") ?? DEFAULT_PUBLISHER,
    walrusAggregatorUrl: readTrimmed("WALRUS_AGGREGATOR_URL") ?? DEFAULT_AGGREGATOR,
  };
}
