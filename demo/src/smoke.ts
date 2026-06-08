// Foundation smoke test. This is how Task 1 is judged: it proves, in order, that
//   (a) the ElizaOS runtime boots and DB migrations run,
//   (b) the public Walrus testnet is reachable (probe round-trips),
//   (c) a Walrus store -> read round-trip is byte-exact,
//   (d) chat memory persists to and reads back from the local DB in order,
//   (e) (only if GROQ_API_KEY is set) the Groq LLM returns non-empty text.
//
// Prints a labeled PASS/FAIL per check and ends with `SMOKE: PASS` or
// `SMOKE: FAIL -- <which>`, setting process.exitCode accordingly. There is NO
// local Walrus fallback: if Walrus is unreachable the script fails loudly.

import { ModelType } from "@elizaos/core";
import { loadConfig } from "./config.js";
import { createDemoRuntime, type DemoRuntime } from "./runtime.js";
import { saveTurn, listTurns } from "./chatMemory.js";
import {
  assertReachable,
  storeBlob,
  readBlob,
  WalrusHttpError,
  type WalrusHttpConfig,
} from "./walrusHttp.js";

function pass(label: string): void {
  console.log(`PASS -- ${label}`);
}

function failLine(label: string, detail?: string): void {
  console.log(`FAIL -- ${label}${detail ? `: ${detail}` : ""}`);
}

function errorDetail(err: unknown): string {
  if (err instanceof WalrusHttpError) {
    const parts = [err.message];
    if (err.status !== undefined) parts.push(`status=${err.status}`);
    parts.push(`url=${err.url}`);
    if (err.body) parts.push(`body=${err.body}`);
    return parts.join(" | ");
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// plugin-groq swallows API errors and returns this sentinel instead of throwing,
// so check (e) must treat it as a failure rather than "non-empty text".
const GROQ_ERROR_SENTINEL = "Error generating text. Please try again later.";

// Placeholder used only to satisfy config + runtime boot when the user supplied
// no Groq key. Checks (a)-(d) do not call Groq, so a fake key is harmless there;
// check (e) is skipped in that case (we never call the LLM with a fake key).
const PLACEHOLDER_GROQ_KEY = "gsk_smoke_placeholder_boot_only";

// Load demo/.env into process.env if present (tsx does not auto-load it). Uses
// Node's built-in loader; missing file is fine (env may come from the shell).
function loadDotEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader(".env");
  } catch {
    // No .env file -- rely on whatever is already in the environment.
  }
}

async function main(): Promise<void> {
  console.log("=== DEMO FOUNDATION SMOKE ===");

  loadDotEnv();

  // Capture whether the USER provided a real Groq key BEFORE we inject any
  // placeholder. Only then does check (e) run.
  const userGroqKey = (process.env.GROQ_API_KEY ?? "").trim();
  const hasRealGroqKey = userGroqKey.length > 0;
  if (!hasRealGroqKey) {
    // Let config + boot proceed; (e) will SKIP.
    process.env.GROQ_API_KEY = PLACEHOLDER_GROQ_KEY;
  }

  const config = loadConfig();
  const walrusConfig: WalrusHttpConfig = {
    publisherUrl: config.walrusPublisherUrl,
    aggregatorUrl: config.walrusAggregatorUrl,
  };

  // (a) Runtime boot + DB migrations.
  let demo: DemoRuntime;
  try {
    demo = await createDemoRuntime(config);
    pass("(a) runtime boots + DB migrations run");
  } catch (err) {
    failLine("(a) runtime boots + DB migrations run", errorDetail(err));
    console.log("SMOKE: FAIL -- (a) runtime boot");
    process.exitCode = 1;
    return;
  }

  // From here, always attempt to stop the runtime before returning.
  try {
    // (b) Walrus testnet reachable. Do NOT mask a failure -- exit non-zero.
    try {
      await assertReachable(walrusConfig);
      pass("(b) walrus testnet reachable (probe round-trips)");
    } catch (err) {
      failLine("(b) walrus testnet reachable", errorDetail(err));
      console.log("SMOKE: FAIL -- walrus unreachable");
      process.exitCode = 1;
      return;
    }

    // (c) Store -> read round-trip of a random ~200-byte payload, byte-exact.
    try {
      const payload = randomBytes(200);
      const { blobId } = await storeBlob(walrusConfig, payload);
      const readBack = await readBlob(walrusConfig, blobId);
      if (!bytesEqual(payload, readBack)) {
        failLine(
          "(c) walrus store/read byte-exact",
          `blobId=${blobId} sent=${payload.length} got=${readBack.length}`,
        );
        console.log("SMOKE: FAIL -- (c) walrus round-trip");
        process.exitCode = 1;
        return;
      }
      console.log(`     stored+read blobId: ${blobId} (${payload.length} bytes)`);
      pass("(c) walrus store/read round-trip byte-exact");
    } catch (err) {
      failLine("(c) walrus store/read byte-exact", errorDetail(err));
      console.log("SMOKE: FAIL -- (c) walrus round-trip");
      process.exitCode = 1;
      return;
    }

    // (d) chatMemory: save two turns, list them back oldest-first from local DB.
    try {
      const roomId = `smoke-room-${Date.now()}`;
      await saveTurn(demo.runtime, { roomId, role: "user", text: "hello from the user" });
      await saveTurn(demo.runtime, { roomId, role: "agent", text: "hello from the agent" });
      const turns = await listTurns(demo.runtime, roomId);
      const ok =
        turns.length === 2 &&
        turns[0]?.role === "user" &&
        turns[0]?.text === "hello from the user" &&
        turns[1]?.role === "agent" &&
        turns[1]?.text === "hello from the agent";
      if (!ok) {
        failLine(
          "(d) chat memory persists + lists in order",
          `got ${JSON.stringify(turns)}`,
        );
        console.log("SMOKE: FAIL -- (d) chat memory");
        process.exitCode = 1;
        return;
      }
      pass("(d) chat memory persists + lists in order from local DB");
    } catch (err) {
      failLine("(d) chat memory persists + lists in order", errorDetail(err));
      console.log("SMOKE: FAIL -- (d) chat memory");
      process.exitCode = 1;
      return;
    }

    // (e) LLM call -- only if the USER supplied a real Groq key.
    if (hasRealGroqKey) {
      try {
        const text = await demo.runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: "In one short sentence, what is the Walrus protocol used for?",
        });
        const value = typeof text === "string" ? text : String(text ?? "");
        if (!value.trim() || value.trim() === GROQ_ERROR_SENTINEL) {
          const why =
            value.trim() === GROQ_ERROR_SENTINEL
              ? "groq returned its error sentinel (check the API key)"
              : "empty response";
          failLine("(e) groq LLM returns text", why);
          console.log("SMOKE: FAIL -- (e) groq LLM");
          process.exitCode = 1;
          return;
        }
        console.log(`     LLM said: ${value.trim().slice(0, 120)}`);
        pass("(e) groq LLM returns non-empty text");
      } catch (err) {
        failLine("(e) groq LLM returns text", errorDetail(err));
        console.log("SMOKE: FAIL -- (e) groq LLM");
        process.exitCode = 1;
        return;
      }
    } else {
      console.log("SKIP (no GROQ_API_KEY) -- (e) groq LLM");
    }

    console.log("SMOKE: PASS");
    process.exitCode = 0;
  } finally {
    await demo.stop();
  }
}

main().catch((err) => {
  console.error("SMOKE: FAIL -- unexpected error");
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
