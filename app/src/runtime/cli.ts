// cli.ts — the interactive "real user" REPL entry: parse --user/--character/--list, resolve the
// character, then hand off to runInteractiveAgent (the reusable harness). The job/intake/socket
// logic lives in runInteractiveAgent so the framework example runner can reuse it with a custom
// result producer. Secrets are never printed.

import { runInteractiveAgent, errorDetail } from "./runInteractiveAgent.js";
import {
  DEFAULT_CHARACTER,
  loadCharacter,
  listCharacters,
  type AgentCharacter,
} from "../character/character.js";
import { marketProducer } from "../jobs/marketProducer.js";

const DEFAULT_USER = "local-user";

// Load app/.env into process.env if present (tsx does not auto-load it).
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

// Parse `--user <name>`, `--character <ref>`, and `--list`. Unknown flags are ignored.
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

// Print the available character files (and the built-in default) and return.
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

// Resolve the character: a --character ref loads + validates a file; absent uses the default.
// A load failure is fatal (the user explicitly asked for it).
async function resolveCharacter(ref: string | undefined): Promise<AgentCharacter> {
  if (ref === undefined) return DEFAULT_CHARACTER;
  const result = await loadCharacter(ref);
  if (!result.ok) {
    console.error(`Failed to load character "${ref}" (${result.kind}): ${result.message}`);
    process.exit(1);
  }
  return result.character;
}

async function main(): Promise<void> {
  loadDotEnv();

  const args = parseArgs(process.argv.slice(2));

  // --list is a read-only discovery flag: print characters and exit, BEFORE the full-setup guard.
  if (args.list) {
    await printCharacterList();
    process.exit(0);
  }

  const character = await resolveCharacter(args.characterRef);
  // Produce finance results from live market data (Pyth) instead of a blind LLM guess: a real
  // price band for price-range jobs, a hold baseline for trading. Used by both the paid lifecycle
  // and free competition jobs.
  await runInteractiveAgent({ character, user: args.user, produce: marketProducer });
}

main().catch((err) => {
  console.error("CLI crashed:");
  console.error(errorDetail(err));
  process.exit(1);
});
