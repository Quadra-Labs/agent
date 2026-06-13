// cli.ts — the interactive "real user" REPL for app's character CLI: boot the
// runtime once, loop on keyboard input through respond()/closeSession()/recallCheckpoint().
// Refuses to start without BOTH GROQ_API_KEY and a funded WALRUS_SIGNER_KEY, so /close is
// always a live durable checkpoint. --user/--character set the (user, agent) index key
// (agent = character.name); reboot under the same pair to /resume. Secrets never printed.

import { createInterface } from "node:readline";

import type { Signer } from "@mysten/sui/cryptography";

import { loadAgentConfig } from "./config.js";
import { createAgentRuntime, type AgentRuntimeHandle } from "./runtime.js";
import { respond } from "../chat/chat.js";
import { closeSession } from "../session/closeSession.js";
import { recallCheckpoint } from "../session/recallCheckpoint.js";
import { normalizeWalrusSigner } from "./walrusSigner.js";
import { listTurns } from "../chat/chatMemory.js";
import { advanceJobLifecycle, type JobState } from "../jobs/jobLifecycle.js";
import { startDeliveryPoll, type DeliveryPollHandle, type DeliveryOutcome } from "../jobs/deliveryPoll.js";
import type { IntakeSession } from "../quadra/intakeClient.js";
import {
  DEFAULT_CHARACTER,
  loadCharacter,
  listCharacters,
  type AgentCharacter,
} from "../character/character.js";
import { resolveMenu } from "../templates/menuOrchestrator.js";
import type { IntakeTemplate } from "../templates/intakeTemplate.js";

const DEFAULT_USER = "local-user";

// Load app/.env into process.env if present (tsx does not auto-load it).
// Mirrors the proofs' loadDotEnv.
function loadDotEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader(".env");
  } catch {
    // No .env file -- rely on whatever is already in the environment.
  }
}

interface CliArgs {
  readonly user: string;
  readonly characterRef: string | undefined;
  /** `--list`: print available characters and exit; no chat session. */
  readonly list: boolean;
}

// Parse `--user <name>`, `--character <ref>`, and `--list`. Unknown flags are ignored
// so the surface stays forgiving. Returns defaults for absent flags.
function parseArgs(argv: readonly string[]): CliArgs {
  let user = DEFAULT_USER;
  let characterRef: string | undefined;
  let list = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "--user" || arg === "-u") && i + 1 < argv.length) {
      user = argv[i + 1];
      i += 1;
    } else if ((arg === "--character" || arg === "-c") && i + 1 < argv.length) {
      characterRef = argv[i + 1];
      i += 1;
    } else if (arg === "--list" || arg === "-l") {
      list = true;
    }
  }
  return { user, characterRef, list };
}

// Print the available character files (and the built-in default) and return. Pure
// read of characters/; needs no secrets, so the CLI calls this BEFORE the full-setup
// guard and runtime boot.
async function printCharacterList(): Promise<void> {
  const entries = await listCharacters();
  console.log("Available characters (pass the name to --character):");
  console.log(`  (default)     ${DEFAULT_CHARACTER.name} — built-in, used when --character is omitted`);
  if (entries.length === 0) {
    console.log("  (no character files found in characters/)");
  } else {
    for (const entry of entries) {
      console.log(`  ${entry.name.padEnd(13)} [${entry.format}] characters/${entry.file}`);
    }
  }
  console.log("");
  console.log("Examples:");
  console.log("  npm run chat -- --character example");
  console.log("  npm run chat -- --user alice --character example");
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

// Render a background delivery-poll outcome into a user-facing line.
function describeDeliveryOutcome(outcome: DeliveryOutcome, session: IntakeSession): string {
  switch (outcome.kind) {
    case "released":
      return `Payment released for job ${session.job_id}. Job complete.`;
    case "rejected":
      return `Delivery could not be released: ${outcome.reason}.`;
    case "unpaid":
      return `No payment was received for session ${session.session_id}; the job session expired.`;
    case "timeout":
      return "The delivery window elapsed without release; the intake engine will refund the user.";
  }
}

// Resolve the character: a --character ref loads + validates a file; absent uses the
// default identity. A load failure is fatal (the user explicitly asked for it), so we
// print the typed reason and exit rather than silently falling back.
async function resolveCharacter(ref: string | undefined): Promise<AgentCharacter> {
  if (ref === undefined) return DEFAULT_CHARACTER;
  const result = await loadCharacter(ref);
  if (!result.ok) {
    console.error(`Failed to load character "${ref}" (${result.kind}): ${result.message}`);
    process.exit(1);
  }
  return result.character;
}

const HELP = [
  "Commands:",
  "  /close            checkpoint this session to Walrus (live) and clear recalled context",
  "  /resume           re-recall the latest checkpoint for this (user, agent)",
  "  /help             show this help",
  "  /exit             quit (does NOT auto-checkpoint; run /close first to persist)",
].join("\n");

async function main(): Promise<void> {
  loadDotEnv();

  const args = parseArgs(process.argv.slice(2));

  // --list is a read-only discovery flag: print characters and exit, BEFORE the
  // full-setup guard (it needs no Groq key / signer and starts no session).
  if (args.list) {
    await printCharacterList();
    process.exit(0);
  }

  const hasGroq = (process.env.GROQ_API_KEY ?? "").trim().length > 0;
  const hasSigner = (process.env.WALRUS_SIGNER_KEY ?? "").trim().length > 0;
  if (!hasGroq || !hasSigner) {
    console.error("Interactive chat requires full setup (presence only; secrets never read aloud):");
    console.error(`  GROQ_API_KEY:      ${hasGroq ? "present" : "MISSING"}  (needed to chat)`);
    console.error(
      `  WALRUS_SIGNER_KEY: ${hasSigner ? "present" : "MISSING"}  (funded testnet key; needed so /close writes a live checkpoint)`,
    );
    console.error("Set both in app/.env (see .env.example), then re-run npm run chat.");
    process.exit(1);
  }

  const character = await resolveCharacter(args.characterRef);
  const config = loadAgentConfig();

  console.log(`=== ${character.name} — interactive chat ===`);
  console.log(`user="${args.user}"  agent="${character.name}"`);
  console.log("Booting runtime (all four plugins live)...");

  let handle: AgentRuntimeHandle;
  try {
    handle = await createAgentRuntime(config, character);
  } catch (err) {
    console.error("Boot failed:");
    console.error(errorDetail(err));
    process.exit(1);
  }

  // A single conversational room for this CLI session. Distinct per launch so the
  // within-session history starts clean; /resume injects prior context via summary.
  const runToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const roomId = `cli-${character.name}-${args.user}-${runToken}`;

  // Read the REAL job templates from the data gateway, self-select the ones this agent
  // offers, and cache the menu in MemWal. resolveMenu NEVER throws and degrades cleanly
  // (gateway outage -> cached menu or no jobs), so a hiccup here is a soft note, not a
  // fatal boot failure. The selected menu drives both the system prompt and the lifecycle.
  let templatesText: string | undefined;
  let jobTemplates: readonly IntakeTemplate[] = [];
  const menu = await resolveMenu({
    runtime: handle.runtime,
    character,
    dataGatewayUrl: config.dataGatewayUrl,
    selectorModel: config.groqLargeModel,
  });
  templatesText = menu.text;
  jobTemplates = menu.templates;
  for (const note of menu.notes) console.log(`[menu] ${note}`);
  if (jobTemplates.length > 0) {
    console.log(`Job menu ready (${menu.source}); the agent can offer ${jobTemplates.length} job type(s).`);
  } else {
    console.log("No offerable jobs for this agent right now; continuing as plain chat.");
  }

  // Recall any prior checkpoint for this (user, agent) and seed the resumed summary.
  let resumedSummary: string | undefined;
  const initialRecall = await recallCheckpoint(handle.runtime, {
    user: args.user,
    agent: character.name,
  });
  if (initialRecall.kind === "recalled") {
    resumedSummary = initialRecall.summary;
    console.log(`Recalled a prior session: ${initialRecall.summary}`);
  } else if (initialRecall.kind === "error") {
    console.warn(`(recall failed: ${initialRecall.errorKind} — starting fresh)`);
  } else {
    console.log("No prior checkpoint for this user/agent — starting fresh.");
  }

  // Arm the automatic job lifecycle: resolve the agent signer (AGENT_SECRET_KEY ??
  // WALRUS_SIGNER_KEY) used to authenticate to the intake engine + data gateway.
  // Full-setup mode guarantees a signer key is present; a parse failure disables the
  // lifecycle (chat still works) instead of crashing. The key is never printed.
  const signerRes = normalizeWalrusSigner(config.agentSignerKey ?? "");
  const lifecycleSigner: Signer | undefined = signerRes.ok ? signerRes.signer : undefined;
  if (jobTemplates.length > 0) {
    if (lifecycleSigner !== undefined) {
      console.log(
        `Job lifecycle armed: I'll open a job with the intake engine at ${config.intakeUrl} when I accept one.`,
      );
    } else {
      console.warn(
        `(job lifecycle disabled: agent signer unparseable — ${signerRes.ok ? "ok" : signerRes.reason})`,
      );
    }
  }
  const lifecycleArmed = jobTemplates.length > 0 && lifecycleSigner !== undefined;
  let jobState: JobState = { phase: "idle" };
  // The background delivery poller, once a job's result is registered. Cancelled on exit.
  let deliveryPoll: DeliveryPollHandle | undefined;

  console.log("");
  console.log(HELP);
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = (): void => rl.setPrompt("you> ");

  let stopping = false;
  const shutdown = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    deliveryPoll?.cancel();
    rl.close();
    await handle.stop();
    process.exit(code);
  };

  // Run one /close: checkpoint the room to Walrus and report the typed outcome. In
  // full-setup mode a funded signer is guaranteed, so "saved" is the expected result;
  // "degraded"/"error" are surfaced honestly rather than claimed as success.
  const doClose = async (): Promise<void> => {
    console.log("Checkpointing session to Walrus...");
    const outcome = await closeSession(handle.runtime, {
      roomId,
      user: args.user,
      agent: character.name,
      session: runToken,
    });
    switch (outcome.kind) {
      case "saved":
        console.log(`Saved: blob ${outcome.blobId} (durable + indexed). Preview: ${outcome.preview}`);
        resumedSummary = undefined; // a fresh checkpoint supersedes the recalled context
        break;
      case "degraded":
        console.log(`Degraded: blob ${outcome.blobId} durable but NOT indexed — /resume may miss it.`);
        break;
      case "empty":
        console.log("Nothing to checkpoint (no turns yet).");
        break;
      case "error":
        console.log(`Checkpoint failed (${outcome.errorKind}): ${outcome.message}`);
        break;
    }
  };

  const doResume = async (): Promise<void> => {
    const recall = await recallCheckpoint(handle.runtime, {
      user: args.user,
      agent: character.name,
    });
    if (recall.kind === "recalled") {
      resumedSummary = recall.summary;
      console.log(`Recalled: ${recall.summary}`);
    } else if (recall.kind === "error") {
      console.log(`Recall failed (${recall.errorKind}): ${recall.message}`);
    } else {
      console.log("No prior checkpoint to recall for this user/agent.");
    }
  };

  prompt();
  rl.prompt();

  rl.on("line", async (raw) => {
    const text = raw.trim();
    if (text.length === 0) {
      rl.prompt();
      return;
    }

    // Slash commands.
    if (text === "/exit" || text === "/quit") {
      await shutdown(0);
      return;
    }
    if (text === "/help") {
      console.log(HELP);
      rl.prompt();
      return;
    }
    if (text === "/close") {
      try {
        await doClose();
      } catch (err) {
        console.error(`/close error: ${errorDetail(err)}`);
      }
      rl.prompt();
      return;
    }
    if (text === "/resume") {
      try {
        await doResume();
      } catch (err) {
        console.error(`/resume error: ${errorDetail(err)}`);
      }
      rl.prompt();
      return;
    }

    // A normal chat turn. The recalled summary (if any) is injected ONCE on the next
    // turn; after the model has seen it we clear it so it is not re-injected every
    // turn (the within-session history then carries the context forward).
    try {
      const reply = await respond(handle.runtime, {
        roomId,
        user: args.user,
        text,
        resumedSummary,
        templatesText,
        systemPrompt: character.systemPrompt,
      });
      resumedSummary = undefined;
      console.log(`${character.name}> ${reply}`);

      // Advance the job lifecycle (accept -> open -> register) from the updated
      // transcript. Self-contained try/catch: a lifecycle hiccup never breaks the chat.
      // When the result is registered (phase -> "delivering"), hand delivery to the
      // background poller so it completes even if the user stops chatting.
      if (lifecycleArmed && lifecycleSigner !== undefined) {
        try {
          const turns = await listTurns(handle.runtime, roomId);
          const beforePhase = jobState.phase;
          const advanced = await advanceJobLifecycle({
            runtime: handle.runtime,
            turns,
            config,
            signer: lifecycleSigner,
            templates: jobTemplates,
            state: jobState,
          });
          jobState = advanced.state;
          for (const note of advanced.notes) console.log(`[job] ${note}`);

          if (
            beforePhase !== "delivering" &&
            jobState.phase === "delivering" &&
            deliveryPoll === undefined &&
            jobState.session !== undefined
          ) {
            const session = jobState.session;
            console.log(
              "[job] Result is in. I'll deliver to the intake engine as soon as your payment confirms — no need to keep chatting.",
            );
            deliveryPoll = startDeliveryPoll({
              baseUrl: config.intakeUrl,
              signer: lifecycleSigner,
              session,
              startedAtMs: jobState.submittedAtMs ?? Date.now(),
              onDone: (outcome) => {
                deliveryPoll = undefined;
                jobState = { phase: "done" };
                console.log(`[job] ${describeDeliveryOutcome(outcome, session)}`);
              },
            });
          }
        } catch (err) {
          console.error(`(job lifecycle error: ${errorDetail(err)})`);
        }
      }
    } catch (err) {
      console.error(`(reply failed: ${errorDetail(err)})`);
    }
    rl.prompt();
  });

  rl.on("SIGINT", () => {
    console.log("\n(use /exit to quit; /close first to persist this session)");
    rl.prompt();
  });
}

main().catch((err) => {
  console.error("CLI crashed:");
  console.error(errorDetail(err));
  process.exit(1);
});
