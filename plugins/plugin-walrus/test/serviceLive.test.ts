// Live service-layer test for WalrusService (Phase 1, Task 6a).
//
// Drives the WalrusService class DIRECTLY against real Walrus testnet — service
// layer only, NOT the plugin/action path (that is Task 6b). It ports the proven
// spike assertions from phase0/spike/p1_5_walrus_hardening.mjs (W1 binary
// round-trip + W4 bad-id) but asserts on the SERVICE's TYPED results, not raw
// SDK calls. Stores OPAQUE BYTES ONLY — no Seal / MemWal / job / template /
// Intake / signing-handshake / sealId concepts appear here.
//
// LIVE-GATED: runs ONLY when WALRUS_LIVE === "1". When unset every case skips
// cleanly so the CI-safe (non-live) suite stays green. This file must not throw
// at import time and must not require a wallet unless the live path runs.
//
// Signer loading (only inside the live path, never logged):
//   1. SUI_TEST_PRIVATE_KEY (a raw bech32 secret) — avoids the CLI, if present.
//   2. else `sui keytool export --key-identity <id> --json`, where <id> defaults
//      to WALRUS_TEST_KEY_IDENTITY or the funded spike wallet "interesting-axinite".
//
// Live footprint per run: ONE store of a tiny random payload at epochs=3,
// deletable=false. "The test passes" must not mean "we drained the wallet."

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import type { Signer } from "@mysten/sui/cryptography";

import { WalrusService } from "../src/walrusService.js";
import { sha256Hex } from "../src/sha256.js";
import { SKIP, loadSigner } from "./liveSigner.js";

// Build the service with NO network I/O. fromConfig (not start) so we can inject
// the Signer object directly — a Signer cannot round-trip through runtime string
// settings.
function makeService(signer?: Signer): WalrusService {
  return WalrusService.fromConfig({
    suiRpcUrl: getJsonRpcFullnodeUrl("testnet"),
    network: "testnet",
    signer,
    epochs: 3,
    deletable: false,
  });
}

// W1 — store -> read round-trip with a SHA-256 match (service typed results).
// ONE store per run, tiny random binary payload.
test("LIVE: store -> read round-trip matches SHA-256", { skip: SKIP }, async () => {
  const service = makeService(loadSigner());

  const original = new Uint8Array(randomBytes(128));
  const inputHash = sha256Hex(original);

  const stored = await service.store(original);
  assert.equal(stored.ok, true, `store failed: ${JSON.stringify(stored)}`);
  assert.ok(stored.ok); // narrow the union for TS
  assert.equal(typeof stored.blobId, "string");
  assert.ok(stored.blobId.length > 0, "store returned an empty blobId");
  assert.equal(stored.sizeBytes, original.length);

  const readResult = await service.read(stored.blobId);
  assert.equal(readResult.ok, true, `read failed: ${JSON.stringify(readResult)}`);
  assert.ok(readResult.ok); // narrow the union for TS
  assert.equal(readResult.bytes.length, original.length, "byte length mismatch");
  assert.equal(sha256Hex(readResult.bytes), inputHash, "SHA-256 round-trip mismatch");
  assert.equal(readResult.blobId, stored.blobId);
});

// W4 — a fake / non-existent blob id read returns a TYPED blob_unavailable
// result: never null, never a thrown-through crash. Needs no signer.
test("LIVE: fake blob id -> typed blob_unavailable result", { skip: SKIP }, async () => {
  const service = makeService();

  // 32 zero bytes, URL-safe base64 (the Walrus blobId encoding) — syntactically
  // plausible but (overwhelmingly likely) non-existent.
  const fakeBlobId = Buffer.from(new Uint8Array(32)).toString("base64url");

  const result = await service.read(fakeBlobId);

  assert.notEqual(result, null, "read returned null instead of a typed result");
  assert.equal(result.ok, false, `expected a failure result, got: ${JSON.stringify(result)}`);
  assert.ok(!result.ok); // narrow the union for TS
  assert.equal(result.kind, "blob_unavailable", `expected blob_unavailable, got kind=${result.kind}`);
  assert.equal(result.blobId, fakeBlobId);
  assert.equal(typeof result.errorName, "string");
  assert.ok(result.errorName.length > 0, "errorName is empty");
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0, "message is empty");
});
