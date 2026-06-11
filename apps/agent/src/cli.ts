// cli.ts — the interactive "real user" entrypoint for apps/agent.
//
// Unlike the eight proofs (which drive HARDCODED turns and assert PASS/FAIL), this
// is a live REPL: it boots the runtime ONCE, then loops on your keyboard input and
// calls the SAME respond() the proofs use, printing the agent's reply each turn.
// Chat history persists to the local PGlite DB exactly as in chatProof, so context
// carries across turns within the session.
//
// COMPOSES, never re-implements: respond() (chat turn), closeSession() (checkpoint
// write), recallCheckpoint() (cross-session recall), loadTemplates()/seedTemplates()
// (job templates on Walrus). It only wires them to stdin/stdout + slash commands.
//
// REQUIRE-FULL-SETUP (decision): this entrypoint refuses to start unless BOTH a real
// GROQ_API_KEY (to chat) AND a funded WALRUS_SIGNER_KEY (so /close does a LIVE Walrus
// write, never a config_error) are present. The proofs keep their graceful tiers;
// the interactive app does not, so /close is always a real durable checkpoint.
//
// IDENTITY: --user and --character set the (user, agent) checkpoint index key
// (agent = character.name). Boot under the same pair later to /resume a prior
// session's checkpoint. Defaults: user "local-user", character DEFAULT_CHARACTER.
//
// Secrets (Groq key, signer) are NEVER printed.

import { createInterface } from "node:readline";

import { loadAgentConfig } from "./config.js";
import { createAgentRuntime, type AgentRuntimeHandle } from "./runtime.js";
import { respond } from "./chat.js";
import { closeSession } from "./closeSession.js";
import { recallCheckpoint } from "./recallCheckpoint.js";
import {
  DEFAULT_CHARACTER,
  loadCharacter,
  listCharacters,
  type AgentCharacter,
} from "./character.js";
import {
  seedTemplates,
  loadTemplates,
  renderTemplatesForPrompt,
  type JobTemplate,
} from "./templates.js";

const DEFAULT_USER = "local-user";

// Load apps/agent/.env into process.env if present (tsx does not auto-load it).
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

// Seed the default template set on Walrus, read it back, and keep ONLY the categories
// the character named. Returns the rendered prompt block, or undefined when the
// character offers no templates / the set is empty. A Walrus failure is fatal here
// (full-setup mode guarantees a funded signer, so a failure is a real problem worth
// surfacing, not a silent degrade).
async function resolveTemplatesText(
  handle: AgentRuntimeHandle,
  character: AgentCharacter,
): Promise<string | undefined> {
  const wanted = character.templateCategoryIds ?? [];
  if (wanted.length === 0) return undefined;

  const seeded = await seedTemplates(handle.runtime);
  if (!seeded.ok) {
    throw new Error(`Could not seed job templates on Walrus (${seeded.kind}): ${seeded.message}`);
  }
  const loaded = await loadTemplates(handle.runtime, seeded.blobId);
  if (!loaded.ok) {
    throw new Error(`Could not load job templates from Walrus (${loaded.kind}): ${loaded.message}`);
  }

  const wantedSet = new Set(wanted);
  const selected: JobTemplate[] = loaded.templates.filter((t) => wantedSet.has(t.category_id));
  const missing = wanted.filter((id) => !selected.some((t) => t.category_id === id));
  if (missing.length > 0) {
    console.warn(`Note: character names unknown template ids, ignoring: ${missing.join(", ")}`);
  }
  if (selected.length === 0) return undefined;
  return renderTemplatesForPrompt(selected);
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
    console.error("Set both in apps/agent/.env (see .env.example), then re-run npm run chat.");
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

  // Optional job-template block for the system prompt (only if the character offers
  // templates). Resolved once at boot.
  let templatesText: string | undefined;
  try {
    templatesText = await resolveTemplatesText(handle, character);
    if (templatesText !== undefined) {
      console.log("Job templates loaded; the agent can do job intake for its categories.");
    }
  } catch (err) {
    console.error("Template setup failed:");
    console.error(errorDetail(err));
    await handle.stop();
    process.exit(1);
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

  console.log("");
  console.log(HELP);
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = (): void => rl.setPrompt("you> ");

  let stopping = false;
  const shutdown = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
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
