// pluginGate.test.ts — plugin/action-path integration test (Phase 1, Task 6b).
//
// THE Phase-1 exit gate. Where 6a (serviceLive.test.ts) drove the WalrusService
// class directly, 6b proves the PLUGIN really wires its parts: it loads the
// actual `walrusPlugin` export, resolves the action OBJECTS and the provider FROM
// the plugin (by name, never importing storeBlobAction/readBlobAction directly),
// registers ONE service instance in a minimal hand-rolled runtime stub, and calls
// the action handlers DIRECTLY (NO LLM / message loop) with a capturing
// HandlerCallback. Assertions are on the emitted Content.data (the locked
// WalrusActionCallback union), not on handler return values.
//
// Covers locked gate items 3-7:
//   3 (non-live): walrusPlugin is a valid ElizaOS Plugin with the expected
//                 services / actions / providers and NO evaluators key.
//   4 (non-live): both actions AND the provider resolve the SAME long-lived
//                 service instance via runtime.getService — proven test-side by
//                 recording every handed-out reference (no src instrumentation).
//   5 (non-live): results surface through HandlerCallback content; an error
//                 branch emits data.type === "walrus.error".
//   6 (LIVE):     plugin-path store -> read, SHA-256 match from the callbacks.
//   7 (LIVE):     plugin-path fake-id read surfaces walrus.read.unavailable.
//
// LIVE-GATED: items 6/7 run ONLY when WALRUS_LIVE === "1" (funded signer);
// items 3/4/5 run unconditionally and keep the CI-safe suite green. Phase 1 is
// OPAQUE BYTES ONLY — no Seal / MemWal / job / template / Intake / signing-
// handshake / sealId concepts appear here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import type { Signer } from "@mysten/sui/cryptography";
import type {
  Action,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Provider,
  State,
} from "@elizaos/core";

import { walrusPlugin } from "../src/index.js";
import { WalrusService } from "../src/walrusService.js";
import { WALRUS_STORE_BLOB } from "../src/storeBlob.js";
import { WALRUS_READ_BLOB } from "../src/readBlob.js";
import { WALRUS_STATUS } from "../src/walrusStatus.js";
import type { WalrusActionCallback } from "../src/types.js";
import { SKIP, loadSigner } from "./liveSigner.js";

// --- Resolve the action objects + provider FROM THE PLUGIN --------------------
// This is the load-bearing part of 6b: we find them by name inside the exported
// plugin (never importing the action/provider objects directly), proving the
// plugin actually wires them. Guarded so a missing wiring fails loudly here.
function actionByName(name: string): Action {
  const found = walrusPlugin.actions?.find((a) => a.name === name);
  assert.ok(found, `walrusPlugin.actions is missing an action named ${name}`);
  return found;
}

function providerByName(name: string): Provider {
  const found = walrusPlugin.providers?.find((p) => p.name === name);
  assert.ok(found, `walrusPlugin.providers is missing a provider named ${name}`);
  return found;
}

const storeAction = actionByName(WALRUS_STORE_BLOB);
const readAction = actionByName(WALRUS_READ_BLOB);
const statusProvider = providerByName(WALRUS_STATUS);

// --- Minimal hand-rolled runtime stub ----------------------------------------
// The action handlers and the provider only ever touch runtime.getService. The
// stub returns the single registered instance for "walrus" and RECORDS every
// reference it hands out, so the test can prove same-instance sharing without any
// production-side counter or instrumentation (gate item 4). A null variant
// simulates an unregistered service (item 5).
type RecordingRuntime = {
  runtime: IAgentRuntime;
  handedOut: unknown[];
};

function makeRuntime(service: WalrusService | null): RecordingRuntime {
  const handedOut: unknown[] = [];
  const runtime = {
    getService: (serviceType: string) => {
      const resolved = serviceType === WalrusService.serviceType ? service : null;
      handedOut.push(resolved);
      return resolved;
    },
  } as unknown as IAgentRuntime;
  return { runtime, handedOut };
}

// A capturing HandlerCallback: stores the emitted Content so the test can assert
// on content.data (the WalrusActionCallback). Resolves to [] (Memory[]), as the
// HandlerCallback signature requires.
function makeCapture(): {
  cb: HandlerCallback;
  captured: () => Content | undefined;
} {
  let last: Content | undefined;
  const cb: HandlerCallback = async (content) => {
    last = content;
    return [];
  };
  return { cb, captured: () => last };
}

const emptyState = {} as unknown as State;

// Build the single registered service with NO network I/O (fromConfig injects the
// Signer directly; a Signer cannot round-trip through runtime string settings).
function makeService(signer?: Signer): WalrusService {
  return WalrusService.fromConfig({
    suiRpcUrl: getJsonRpcFullnodeUrl("testnet"),
    network: "testnet",
    signer,
    epochs: 3,
    deletable: false,
  });
}

function dataOf(content: Content | undefined): WalrusActionCallback {
  assert.ok(content, "handler emitted no callback Content");
  assert.ok(content.data, "callback Content carried no `data`");
  return content.data as WalrusActionCallback;
}

// --- Item 3 (non-live): valid ElizaOS Plugin shape ---------------------------
test("item3: walrusPlugin is a valid ElizaOS Plugin with the expected wiring", () => {
  assert.equal(walrusPlugin.name, "plugin-walrus");

  // services contains the WalrusService CLASS (Plugin.services is (typeof Service)[]).
  const services = walrusPlugin.services ?? [];
  assert.ok(
    services.some((s) => (s as unknown) === (WalrusService as unknown)),
    "walrusPlugin.services must contain the WalrusService class",
  );

  // actions contains both actions by name.
  const actionNames = (walrusPlugin.actions ?? []).map((a) => a.name);
  assert.ok(actionNames.includes(WALRUS_STORE_BLOB), "missing WALRUS_STORE_BLOB action");
  assert.ok(actionNames.includes(WALRUS_READ_BLOB), "missing WALRUS_READ_BLOB action");

  // providers contains the status provider by name.
  const providerNames = (walrusPlugin.providers ?? []).map((p) => p.name);
  assert.ok(providerNames.includes(WALRUS_STATUS), "missing WALRUS_STATUS provider");

  // Phase 1 declares NO evaluators — the key must be absent (not just empty).
  assert.ok(
    !Object.prototype.hasOwnProperty.call(walrusPlugin, "evaluators"),
    "Phase 1 must declare no `evaluators` key on the plugin",
  );
});

// --- Item 4 (non-live): same long-lived instance across both actions + provider
// Proven purely test-side: the recording stub captures every reference handed out
// by getService. After driving store handler, read handler, and the provider, we
// assert exactly three lookups happened and all three returned the SAME instance.
// No constructor counter, no production-side instrumentation.
test("item4: both actions and the provider resolve the SAME service instance", async () => {
  const service = makeService(); // signerless is fine; we only need the identity.
  const { runtime, handedOut } = makeRuntime(service);

  // Drive the store handler (signerless -> store() returns config_error, but the
  // service IS resolved first, which is the lookup we are recording).
  const store = makeCapture();
  const storeMessage = { content: { bytes: new Uint8Array([1, 2, 3]) } } as unknown as Memory;
  await storeAction.handler(runtime, storeMessage, emptyState, {}, store.cb);

  // Drive the read handler fully OFFLINE: an INPUT-invalid message (no blobId,
  // non-blob-shaped text) makes the handler resolve the service (the lookup we are
  // recording) and then fail input resolution BEFORE any network I/O.
  const read = makeCapture();
  const readMessage = { content: { text: "not a blob id" } } as unknown as Memory;
  await readAction.handler(runtime, readMessage, emptyState, {}, read.cb);

  // Drive the provider's get (its only runtime touch is getService).
  await statusProvider.get(runtime, storeMessage, emptyState);

  // Exactly three service lookups: store handler, read handler, provider.
  assert.equal(handedOut.length, 3, `expected 3 getService lookups, got ${handedOut.length}`);
  for (const ref of handedOut) {
    assert.ok(ref === service, "a lookup returned a different service reference");
  }
});

// --- Item 5 (non-live): results surface through HandlerCallback content --------
// Two error branches, both via the callback's data (never a bare return):
//   (a) service unavailable (getService -> null) -> walrus.error,
//       message "walrus service is not registered".
//   (b) signerless store() -> config_error mapped to walrus.error, op "store".
test("item5a: store with no service emits walrus.error via the callback", async () => {
  const { runtime } = makeRuntime(null); // getService returns null
  const { cb, captured } = makeCapture();

  const message = { content: { bytes: new Uint8Array([9]) } } as unknown as Memory;
  await storeAction.handler(runtime, message, emptyState, {}, cb);

  const data = dataOf(captured());
  assert.equal(data.type, "walrus.error");
  assert.ok(data.type === "walrus.error"); // narrow for TS
  assert.equal(data.operation, "store");
  assert.equal(data.message, "walrus service is not registered");
});

test("item5b: signerless store emits walrus.error (store) via the callback", async () => {
  const service = makeService(); // no signer -> store() returns config_error
  const { runtime } = makeRuntime(service);
  const { cb, captured } = makeCapture();

  const message = { content: { bytes: new Uint8Array([1, 2, 3, 4]) } } as unknown as Memory;
  await storeAction.handler(runtime, message, emptyState, {}, cb);

  const data = dataOf(captured());
  assert.equal(data.type, "walrus.error");
  assert.ok(data.type === "walrus.error"); // narrow for TS
  assert.equal(data.operation, "store");
  assert.ok(data.message.length > 0, "walrus.error carried an empty message");
});

// --- Item 6 (LIVE): plugin-path store -> read SHA-256 match --------------------
// ONE store of a tiny random payload (epochs=3, deletable=false), then a read of
// the returned blobId — both through the ACTION handlers. Assert the store and
// read callbacks carry matching sha256 (and sizes). Also reinforces item 4
// behaviourally: the live store flows through the same instance, so the provider's
// output and service.recentHandles() contain that blobId.
test("item6: LIVE plugin-path store -> read matches SHA-256", { skip: SKIP }, async () => {
  const service = makeService(loadSigner());
  const { runtime, handedOut } = makeRuntime(service);

  const original = new Uint8Array(randomBytes(96));

  // Store via the action handler. Pass raw bytes via options.bytes.
  const store = makeCapture();
  const storeMessage = { content: {} } as unknown as Memory;
  await storeAction.handler(runtime, storeMessage, emptyState, { bytes: original }, store.cb);

  const storeData = dataOf(store.captured());
  assert.equal(storeData.type, "walrus.store.success", `store failed: ${JSON.stringify(storeData)}`);
  assert.ok(storeData.type === "walrus.store.success"); // narrow for TS
  assert.ok(storeData.blobId.length > 0, "store callback returned an empty blobId");
  assert.equal(storeData.sizeBytes, original.length);

  // Read via the action handler. Pass the blobId via explicit content.blobId so it
  // bypasses the shape gate and reaches the service.
  const read = makeCapture();
  const readMessage = { content: { blobId: storeData.blobId } } as unknown as Memory;
  await readAction.handler(runtime, readMessage, emptyState, {}, read.cb);

  const readData = dataOf(read.captured());
  assert.equal(readData.type, "walrus.read.success", `read failed: ${JSON.stringify(readData)}`);
  assert.ok(readData.type === "walrus.read.success"); // narrow for TS
  assert.equal(readData.blobId, storeData.blobId);
  assert.equal(readData.sizeBytes, storeData.sizeBytes, "size mismatch store vs read");
  assert.equal(readData.sha256, storeData.sha256, "SHA-256 mismatch store vs read");

  // Behavioural same-instance reinforcement: shared state carries the blobId.
  assert.ok(
    service.recentHandles().some((h) => h.blobId === storeData.blobId),
    "service.recentHandles() did not contain the just-stored blobId (not the same instance)",
  );
  const status = await statusProvider.get(runtime, readMessage, emptyState);
  assert.ok(
    (status.text ?? "").includes(storeData.blobId),
    "provider output did not contain the just-stored blobId (not the same instance)",
  );

  // All lookups in this live flow resolved the one registered instance.
  for (const ref of handedOut) {
    assert.ok(ref === service, "a live lookup returned a different service reference");
  }
});

// --- Item 7 (LIVE): plugin-path fake-id read -> walrus.read.unavailable --------
// The id is passed via explicit content.blobId so it bypasses the shape gate and
// reaches the service, which classifies a non-certified blob as the typed
// unavailable VALUE (NOT walrus.read.unavailable's cousin "not_found"). Read needs
// no signer.
test("item7: LIVE plugin-path fake-id read surfaces walrus.read.unavailable", { skip: SKIP }, async () => {
  const service = makeService(); // read needs no signer
  const { runtime } = makeRuntime(service);

  // 32 zero bytes, URL-safe base64 (the Walrus blobId encoding) — syntactically
  // plausible but (overwhelmingly likely) non-existent.
  const fakeBlobId = Buffer.from(new Uint8Array(32)).toString("base64url");

  const read = makeCapture();
  const readMessage = { content: { blobId: fakeBlobId } } as unknown as Memory;
  await readAction.handler(runtime, readMessage, emptyState, {}, read.cb);

  const data = dataOf(read.captured());
  assert.equal(
    data.type,
    "walrus.read.unavailable",
    `expected walrus.read.unavailable, got: ${JSON.stringify(data)}`,
  );
  assert.ok(data.type === "walrus.read.unavailable"); // narrow for TS
  assert.equal(data.blobId, fakeBlobId);
  assert.ok(data.errorName.length > 0, "errorName is empty");
  assert.ok(data.message.length > 0, "message is empty");
});
