// liveSigner.ts — shared live-gating flag + funded-signer loader for the
// live Walrus tests (Phase 1, Tasks 6a/6b).
//
// Extracted verbatim from the original serviceLive.test.ts (Task 6a) loader so
// the service-direct (6a) and plugin-path (6b) live tests share ONE signer
// path instead of duplicating it. Behaviour is unchanged: gate on
// WALRUS_LIVE === "1"; load the signer ONLY inside the live path; NEVER log the
// secret material. Phase 1 is OPAQUE BYTES ONLY — no Seal / MemWal / job /
// template / Intake / signing-handshake / sealId concepts appear here.
//
// Signer loading (only invoked from a live test, never at import time):
//   1. SUI_TEST_PRIVATE_KEY (a raw bech32 secret) — avoids the CLI, if present.
//   2. else `sui keytool export --key-identity <id> --json`, where <id> defaults
//      to WALRUS_TEST_KEY_IDENTITY or the funded spike wallet "interesting-axinite".

import { execFileSync } from "node:child_process";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Signer } from "@mysten/sui/cryptography";

// True only when the live testnet path is explicitly requested. When false every
// live case skips and no wallet / CLI is touched.
export const LIVE = process.env.WALRUS_LIVE === "1";

// Skip reason for node:test's `{ skip }` option — false runs, string skips.
export const SKIP: false | string = LIVE
  ? false
  : "WALRUS_LIVE!=1 (live testnet test skipped)";

// Default funded spike wallet (0x0988...); overridable via env.
const DEFAULT_KEY_IDENTITY = "interesting-axinite";

// Load the funded signer WITHOUT ever logging the secret material. Prefers a raw
// bech32 key from env (no CLI dependency), otherwise shells out to the sui CLI
// keytool export. Returns an Ed25519Keypair (a Signer). Throws on failure — the
// caller distinguishes funding/CLI issues from code issues by inspecting the
// thrown error.
export function loadSigner(): Signer {
  const rawKey = process.env.SUI_TEST_PRIVATE_KEY;
  if (typeof rawKey === "string" && rawKey.trim().length > 0) {
    return Ed25519Keypair.fromSecretKey(rawKey.trim());
  }

  const identity = process.env.WALRUS_TEST_KEY_IDENTITY ?? DEFAULT_KEY_IDENTITY;
  const out = execFileSync(
    "sui",
    ["keytool", "export", "--key-identity", identity, "--json"],
    { encoding: "utf8" },
  );
  const json = JSON.parse(out.slice(out.indexOf("{")));
  const bech32: unknown = json.exportedPrivateKey ?? json.key?.exportedPrivateKey;
  if (typeof bech32 !== "string" || bech32.length === 0) {
    throw new Error(
      `sui keytool export for key-identity "${identity}" returned no exportedPrivateKey`,
    );
  }
  return Ed25519Keypair.fromSecretKey(bech32);
}
