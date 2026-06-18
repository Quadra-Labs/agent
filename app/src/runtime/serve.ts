// serve.ts — run the agent as an HTTP service the Quadra web can chat with directly.
// Parses --character/--list, resolves the character, then hands off to runHttpAgent. Mirrors
// cli.ts (the interactive REPL) but serves /ping + /chat over HTTP instead of stdin. Run:
//   npm run serve -- --character example   (set AGENT_PUBLIC_URL so the web can discover it)

import { runHttpAgent } from "./runHttpAgent.js";
import { errorDetail } from "./runInteractiveAgent.js";
import {
  DEFAULT_CHARACTER,
  loadCharacter,
  listCharacters,
  type AgentCharacter,
} from "../character/character.js";
import { marketProducer } from "../jobs/marketProducer.js";

function loadDotEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader(".env");
  } catch {
    // No .env file — rely on whatever is already in the environment.
  }
}

function parseArgs(argv: readonly string[]): { characterRef: string | undefined; list: boolean } {
  let characterRef: string | undefined;
  let list = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "--character" || arg === "-c") && i + 1 < argv.length) {
      characterRef = argv[i + 1];
      i += 1;
    } else if (arg === "--list" || arg === "-l") {
      list = true;
    }
  }
  return { characterRef, list };
}

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
  if (args.list) {
    const entries = await listCharacters();
    console.log("Available characters (pass the name to --character):");
    console.log(`  (default)     ${DEFAULT_CHARACTER.name} — built-in`);
    for (const entry of entries) console.log(`  ${entry.name.padEnd(13)} [${entry.format}]`);
    process.exit(0);
  }
  const character = await resolveCharacter(args.characterRef);
  await runHttpAgent({ character, produce: marketProducer });
}

main().catch((err) => {
  console.error("serve crashed:");
  console.error(errorDetail(err));
  process.exit(1);
});
