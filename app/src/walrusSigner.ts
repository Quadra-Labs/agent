// walrusSigner.ts — normalize a Sui signer secret (carried as a string in
// character.settings) into a @mysten/sui Signer for the Walrus SDK store path. Accepts
// bech32 "suiprivkey1..." or a base64 32-byte ed25519 seed. NEVER logs the key — failures
// return a typed error with a generic reason; a missing secret is not an error (read-only).

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import type { Signer } from "@mysten/sui/cryptography";

export type SignerNormalizeResult =
  | { ok: true; signer: Signer }
  // The key was present but could not be parsed. `reason` is a generic label;
  // it NEVER contains the key material.
  | { ok: false; reason: string };

const ED25519_SEED_BYTES = 32;

// Fixed, key-free label for a bech32 decode failure. decodeSuiPrivateKey throws
// with a message that can echo the malformed input, so we NEVER surface its
// message; this constant replaces it. (Carry-forward: never log the key.)
const BECH32_DECODE_FAILED = "bech32 private key could not be decoded";

function fromBech32(secret: string): Signer | undefined {
  if (!secret.startsWith("suiprivkey")) return undefined;
  // Decode in its own try so a malformed-key throw is replaced with a fixed
  // label and the decoder's (possibly key-echoing) message never escapes.
  let scheme: string;
  let secretKey: Uint8Array;
  try {
    ({ scheme, secretKey } = decodeSuiPrivateKey(secret));
  } catch {
    throw new Error(BECH32_DECODE_FAILED);
  }
  if (scheme !== "ED25519") {
    throw new Error(`unsupported key scheme "${scheme}" (only ED25519 is supported)`);
  }
  return Ed25519Keypair.fromSecretKey(secretKey);
}

function fromBase64Seed(secret: string): Signer {
  const seed = Buffer.from(secret, "base64");
  if (seed.length !== ED25519_SEED_BYTES) {
    throw new Error(
      `base64 secret decodes to ${seed.length} bytes; expected ${ED25519_SEED_BYTES}`,
    );
  }
  return Ed25519Keypair.fromSecretKey(new Uint8Array(seed));
}

/**
 * Normalize a signer secret string into a Signer. Returns ok:false (with a
 * key-free reason) when the secret is present but unparseable. Callers pass an
 * already-present, non-empty string here; absence is handled upstream (undefined
 * -> read-only boot). NEVER logs the secret.
 */
export function normalizeWalrusSigner(secret: string): SignerNormalizeResult {
  const trimmed = secret.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty signer secret" };
  }
  try {
    const signer = fromBech32(trimmed) ?? fromBase64Seed(trimmed);
    return { ok: true, signer };
  } catch (err) {
    // Surface only the failure category, never the key bytes.
    const reason = err instanceof Error ? err.message : "unparseable signer secret";
    return { ok: false, reason };
  }
}
