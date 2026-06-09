// roundtrip.ts — A3 Task 2 deliverable: PROVE the live checkpoint round-trip.
//
// "Done" definition (the ONLY bar): build a hand-crafted full seven-field
// Checkpoint { roomId, createdAt, turnCount, summary, user, agent, session },
// call MemwalService.writeCheckpoint(cp) and get ok:true with a REAL blobId, then
// MemwalService.readCheckpoint(blobId) returns a byte-faithful Checkpoint that
// deep-equals the input. The call goes through the booted runtime's RESOLVED
// `memwal` service (the Task-1 handle), NOT a hand-constructed service.
//
// Funded-key reality (locked): A3 uses the plugin-walrus SDK path with a FUNDED
// Sui testnet signer (NOT the demo HTTP publisher). The live store needs gas. If
// WALRUS_SIGNER_KEY is absent (or blank), this script SKIPS the live round-trip
// with a clear message and a DISTINCT NON-FAILURE exit (exit 0) rather than
// crashing or reporting a false failure. There is NO local fallback and NO stub:
// when the key is present it performs the REAL store + read against Walrus.
//
// The secret is NEVER logged or echoed.
//
// Scope: signer + round-trip proof ONLY. It does NOT build chat memory, the
// checkpoint writer, recall, or summarization (Tasks 3-6).

import { loadAgentConfig } from "./config.js";
import { createAgentRuntime, type AgentRuntimeHandle } from "./runtime.js";
import type {
  Checkpoint,
  ReadCheckpointResult,
  WriteCheckpointResult,
} from "../../../plugins/plugin-memwal/src/types.js";

// Placeholder so config + boot proceed without a real Groq key. This task never
// calls the LLM; service resolution does not depend on Groq.
const PLACEHOLDER_GROQ_KEY = "gsk_roundtrip_placeholder_services_only";

// Exit codes. SKIP and PASS share exit 0 (both are NON-FAILURES per the locked
// decision); only a real failure is non-zero (1). SKIP is therefore NOT distinguished
// by exit code — it is distinguished by its DISTINCT terminal log line
// ("ROUNDTRIP: SKIP -- no funded signer ...") vs. the PASS line
// ("ROUNDTRIP: PASS (live) -- ..."). A caller that needs to tell them apart must read
// that line, not the exit code.
const EXIT_PASS = 0;
const EXIT_SKIP = 0;
const EXIT_FAIL = 1;

function log(line: string): void {
  console.log(line);
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

// Load apps/agent/.env into process.env if present (tsx does not auto-load it).
// A missing file is fine (env may come from the shell). Mirrors boot.ts.
function loadDotEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader(".env");
  } catch {
    // No .env file -- rely on whatever is already in the environment.
  }
}

// The minimal MemWal surface this script drives, resolved from the booted runtime.
// Structural so we never reconstruct the real service: getService("memwal")
// returns the Task-1 handle, which we narrow to exactly the two methods we call.
type MemwalLike = {
  writeCheckpoint(cp: Checkpoint): Promise<WriteCheckpointResult>;
  readCheckpoint(blobId: string): Promise<ReadCheckpointResult>;
};

// A hand-crafted full seven-field Checkpoint. Deliberately fixed values (no
// randomness) so the deep-equal assertion is deterministic; createdAt is a fixed
// epoch ms so re-runs are reproducible.
function buildCheckpoint(): Checkpoint {
  return {
    roomId: "a3-roundtrip-room",
    createdAt: 1_749_000_000_000,
    turnCount: 7,
    summary: "A3 Task 2 live round-trip: hand-crafted seven-field checkpoint.",
    user: "roundtrip-user",
    agent: "WalrusAgent",
    session: "roundtrip-session-001",
  };
}

// Field-by-field deep equality over the seven-field Checkpoint. Returns the first
// differing field name, or undefined when byte-faithful. Avoids JSON.stringify
// ordering pitfalls by comparing the known fields explicitly.
function firstCheckpointDiff(a: Checkpoint, b: Checkpoint): string | undefined {
  if (a.roomId !== b.roomId) return "roomId";
  if (a.createdAt !== b.createdAt) return "createdAt";
  if (a.turnCount !== b.turnCount) return "turnCount";
  if (a.summary !== b.summary) return "summary";
  if (a.user !== b.user) return "user";
  if (a.agent !== b.agent) return "agent";
  if (a.session !== b.session) return "session";
  return undefined;
}

// Run the live store + read through the resolved memwal service and assert the
// round-trip. Returns the chosen process exit code. NEVER logs the signer secret.
async function runLiveRoundTrip(memwal: MemwalLike): Promise<number> {
  const cp = buildCheckpoint();
  log("--- writeCheckpoint (live Walrus store; needs gas) ---");

  const write = await memwal.writeCheckpoint(cp);
  if (!write.ok) {
    log(`FAIL -- writeCheckpoint returned ok:false (kind=${write.kind}): ${write.message}`);
    log("ROUNDTRIP: FAIL -- live store did not succeed");
    return EXIT_FAIL;
  }
  if (typeof write.blobId !== "string" || write.blobId.length === 0) {
    log("FAIL -- writeCheckpoint ok:true but blobId is missing/empty");
    log("ROUNDTRIP: FAIL -- no real blobId");
    return EXIT_FAIL;
  }
  log(`PASS -- writeCheckpoint ok:true blobId=${write.blobId} indexed=${write.indexed ?? false}`);

  log("--- readCheckpoint (live Walrus read) ---");
  const read = await memwal.readCheckpoint(write.blobId);
  if (!read.ok) {
    log(`FAIL -- readCheckpoint returned ok:false (kind=${read.kind}): ${read.message}`);
    log("ROUNDTRIP: FAIL -- read-back failed");
    return EXIT_FAIL;
  }

  const diff = firstCheckpointDiff(cp, read.checkpoint);
  if (diff !== undefined) {
    log(`FAIL -- read-back checkpoint differs from input at field "${diff}"`);
    log("ROUNDTRIP: FAIL -- not byte-faithful");
    return EXIT_FAIL;
  }

  log("PASS -- readCheckpoint deep-equals the input (byte-faithful round-trip)");
  log(`ROUNDTRIP: PASS (live) -- blobId=${write.blobId}`);
  return EXIT_PASS;
}

async function main(): Promise<void> {
  log("=== A3 TASK 2: MemWal checkpoint round-trip (live Walrus) ===");

  loadDotEnv();

  if ((process.env.GROQ_API_KEY ?? "").trim().length === 0) {
    process.env.GROQ_API_KEY = PLACEHOLDER_GROQ_KEY;
  }

  // loadAgentConfig trims WALRUS_SIGNER_KEY and yields `undefined` when absent or
  // blank -- the same normalization the runtime uses. We detect that here and SKIP
  // the live store cleanly, BEFORE doing any network work. The key itself is never
  // logged; we only branch on its presence.
  const config = loadAgentConfig();
  if (config.walrusSignerKey === undefined) {
    log(
      "SKIP -- WALRUS_SIGNER_KEY not set / not funded - skipping live round-trip; " +
        "set a funded testnet key in apps/agent/.env to run it.",
    );
    log("ROUNDTRIP: SKIP -- no funded signer (clean, non-failure)");
    process.exitCode = EXIT_SKIP;
    return;
  }

  log("WALRUS_SIGNER_KEY present -- booting runtime and running the LIVE round-trip.");

  let handle: AgentRuntimeHandle;
  try {
    handle = await createAgentRuntime(config);
  } catch (err) {
    log("FAIL -- runtime boot failed");
    log(errorDetail(err));
    log("ROUNDTRIP: FAIL -- boot");
    process.exitCode = EXIT_FAIL;
    return;
  }

  try {
    // Resolve the Task-1 memwal handle from the booted runtime (NOT a
    // hand-constructed service). MemwalService composes the live WalrusService
    // underneath, so this is the genuine end-to-end path.
    const resolved = handle.runtime.getService("memwal");
    if (resolved === undefined || resolved === null) {
      log('FAIL -- getService("memwal") is not live');
      log("ROUNDTRIP: FAIL -- memwal service not live");
      process.exitCode = EXIT_FAIL;
      return;
    }
    const memwal = resolved as unknown as MemwalLike;
    process.exitCode = await runLiveRoundTrip(memwal);
  } catch (err) {
    log("FAIL -- unexpected error during round-trip");
    log(errorDetail(err));
    log("ROUNDTRIP: FAIL -- unexpected");
    process.exitCode = EXIT_FAIL;
  } finally {
    await handle.stop();
  }
}

main().catch((err) => {
  console.error("ROUNDTRIP: FAIL -- unexpected error");
  console.error(errorDetail(err));
  process.exitCode = EXIT_FAIL;
});
