// examples/chat.ts — TALK to the example agents, for real.
//
// This is the real-life host for the example agents: it boots the PRODUCTION runtime
// (plugin-groq LLM + PGlite chat DB + Walrus/MemWal checkpoint rails), starts the chosen
// defineAgent definition via runAgent, and loops on stdin. Every line you type is a real
// turn: the LLM reads your message, DECIDES whether to call the agent's tools (the
// in-process MCP server — fetch_pokemon, fetch_btc_price, compute_btc_range...), and
// answers from the observations. /close writes a real checkpoint; relaunching with the
// same --user RECALLS it — the full cross-session memory story, live.
//
// REQUIREMENTS (default, real mode): GROQ_API_KEY in app/.env — the host
// runtime's LLM provider is plugin-groq, and tool DECISIONS need a real model. (The
// framework itself is provider-agnostic and never sees the key; swap the provider
// plugin in app/src/runtime.ts to use a different LLM — no framework changes.)
// WALRUS_SIGNER_KEY is OPTIONAL: without it /close reports its typed non-saved outcome
// honestly and chatting still fully works.
//
// SANDBOX MODE (--sandbox): no keys at all — an in-memory stub runtime with a canned
// model. The rails run (the MCP tool server boots, turns persist, /close exercises the
// checkpoint rail against a fake memwal) but the canned model cannot DECIDE to call
// tools, so replies are canned. Useful to poke the machinery offline; the real
// experience is the default mode.
//
// USAGE (from framework/):
//   npm run chat:example                          # pokemon agent, REAL runtime
//   npm run chat:example -- --agent btc           # the BTC research agent
//   npm run chat:example -- --user alice          # per-user memory (recall on relaunch)
//   npm run chat:example -- --sandbox             # keyless stub (rails only)
// In-REPL: /close (checkpoint), /help, /exit.

import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { IAgentRuntime } from "@elizaos/core";

import { loadAgentConfig } from "../../app/src/config.js";
import { createAgentRuntime } from "../../app/src/runtime.js";
import { makeStubRuntime, cannedModel } from "./stubRuntime.js";
import {
  runAgent,
  describeModels,
  hasUsableProvider,
  type AgentDefinition,
  type AgentSession,
} from "../src/index.js";
import pokemonAgent from "./pokemonAgent.js";
import btcResearchAgent from "./btcResearchAgent.js";

const here = dirname(fileURLToPath(import.meta.url));

// The selectable example agents, keyed by the --agent value.
const AGENTS: Record<string, AgentDefinition> = {
  pokemon: pokemonAgent,
  btc: btcResearchAgent,
};

// Load app/.env into process.env if present (tsx does not auto-load it).
// Absolute path because this host runs from framework/examples/.
function loadDotEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader(resolve(here, "..", "..", "app", ".env"));
  } catch {
    // No .env file — rely on whatever is already in the environment.
  }
}

// --- the keyless SANDBOX runtime (--sandbox) ---------------------------------------
// The MCP tool server still boots and turns still persist, but the canned model
// cannot decide to call tools — replies are the canned line.
const makeSandboxRuntime = (): IAgentRuntime =>
  makeStubRuntime({
    id: "examples-chat-sandbox",
    model: cannedModel(
      "(sandbox: canned model — run without --sandbox to talk to the real LLM)",
    ),
  }).runtime;

interface ChatArgs {
  readonly agentKey: string;
  readonly user: string;
  readonly sandbox: boolean;
}

// Parse --agent/-a, --user/-u, --sandbox. Unknown flags are ignored. Each LLM-driven
// tool call is already logged compactly by the loop ([tool] name args -> result).
function parseArgs(argv: readonly string[]): ChatArgs {
  let agentKey = "pokemon";
  let user = "local-user";
  let sandbox = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "--agent" || arg === "-a") && i + 1 < argv.length) agentKey = argv[i + 1];
    if ((arg === "--user" || arg === "-u") && i + 1 < argv.length) user = argv[i + 1];
    if (arg === "--sandbox") sandbox = true;
  }
  return { agentKey, user, sandbox };
}

const HELP = [
  "Commands:",
  "  /close   checkpoint this session (real Walrus write when a signer is configured)",
  "  /help    show this help",
  "  /exit    quit",
].join("\n");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const selected = AGENTS[args.agentKey];
  if (selected === undefined) {
    console.error(
      `Unknown --agent "${args.agentKey}". Choose one of: ${Object.keys(AGENTS).join(", ")}.`,
    );
    process.exit(1);
  }
  // Sandbox is keyless: strip the provider chain so turns hit the stub's canned model.
  const agent: AgentDefinition = args.sandbox ? { ...selected, models: [] } : selected;

  // --- boot the runtime for the chosen mode ---------------------------------------
  let runtime: IAgentRuntime;
  let stopRuntime: () => Promise<void> = async () => {};
  if (args.sandbox) {
    runtime = makeSandboxRuntime();
  } else {
    loadDotEnv();
    // Chain-configured agents: any one usable provider key is enough (keys are
    // checked by env-var NAME only, never printed). Chain-less agents still need
    // GROQ (the runtime's own model).
    if (agent.models.length > 0) {
      for (const line of describeModels(agent.models)) {
        console.log(`[model] ${line}`);
      }
      if (!hasUsableProvider(agent.models)) {
        console.error("No usable provider for this agent's model chain. Set one of the");
        console.error("keys above in app/.env, or run with --sandbox.");
        process.exit(1);
      }
    } else if ((process.env.GROQ_API_KEY ?? "").trim().length === 0) {
      console.error("This agent has no model chain, so it runs on the host runtime's model");
      console.error("(plugin-groq). Set GROQ_API_KEY in app/.env, or run with --sandbox.");
      process.exit(1);
    }
    const hasSigner = (process.env.WALRUS_SIGNER_KEY ?? "").trim().length > 0;
    console.log("Booting the real runtime (PGlite + Walrus/MemWal)...");
    if (!hasSigner) {
      console.log("(no WALRUS_SIGNER_KEY: chat fully works; /close will report a non-saved outcome)");
    }
    const handle = await createAgentRuntime(loadAgentConfig(), agent.character);
    runtime = handle.runtime;
    stopRuntime = handle.stop;
  }

  // One conversational room per launch (fresh within-session history); memory across
  // launches comes from the checkpoint recall keyed on (user, agent.name).
  const runToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const roomId = `examples-${args.agentKey}-${args.user}-${runToken}`;

  const session: AgentSession = await runAgent(agent, {
    runtime,
    user: args.user,
    roomId,
    session: runToken,
  });

  console.log(`\n=== ${agent.name} — ${args.sandbox ? "SANDBOX (keyless stub)" : "LIVE (real LLM decides the tool calls)"} ===`);
  console.log(`user="${args.user}"  tools=[${agent.tools.map((t) => t.name).join(", ")}]`);
  if (session.recall.kind === "recalled") {
    console.log(`Recalled a prior session: ${session.recall.summary}`);
  } else if (session.recall.kind === "error") {
    console.log(`(recall failed: starting fresh)`);
  } else {
    console.log("No prior checkpoint for this user/agent — starting fresh.");
  }
  if (args.agentKey === "pokemon") {
    console.log('Try: "tell me about pikachu" / "compare charizard and bulbasaur"');
  } else {
    console.log('Try: "what is the btc price and a likely range?" / "use a 10% band"');
    console.log('     "how much btc was traded in the last hour?"');
  }
  console.log("");
  console.log(HELP);
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("you> ");

  let stopping = false;
  let closed = false; // readline auto-closes on piped EOF; guard prompt/close against it.
  const shutdown = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    if (!closed) rl.close();
    await stopRuntime();
    // Exit NATURALLY rather than process.exit(): forcing it while libuv tears down the
    // stdin handle trips a UV_HANDLE_CLOSING assertion on Windows with piped input.
    process.stdin.pause();
    process.stdin.unref();
  };
  const safePrompt = (): void => {
    if (!closed && !stopping) rl.prompt();
  };

  // Handle ONE line. Returns false to keep going, true to stop.
  const handleLine = async (raw: string): Promise<boolean> => {
    const text = raw.trim();
    if (text.length === 0) return false;
    if (text === "/exit" || text === "/quit") return true;
    if (text === "/help") {
      console.log(HELP);
      return false;
    }
    if (text === "/close") {
      try {
        const outcome = await session.close();
        if (outcome.kind === "saved") {
          console.log(`Checkpoint saved (blob ${outcome.blobId}). Relaunch with the same --user to recall it.`);
        } else {
          console.log(`(checkpoint rail -> kind:"${outcome.kind}")`);
        }
      } catch (err) {
        console.error(`/close error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return false;
    }
    try {
      const reply = await session.turn(text);
      console.log(`${agent.name}> ${reply}`);
    } catch (err) {
      console.error(`(reply failed: ${err instanceof Error ? err.message : String(err)})`);
    }
    return false;
  };

  // Serial line queue: readline emits buffered lines synchronously (notably with piped
  // input), so without serialization multiple async turns would race and /exit could
  // exit mid-fetch. Queue each line and drain one at a time, awaiting each turn fully.
  const queue: string[] = [];
  let draining = false;
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const line = queue.shift() as string;
      const stop = await handleLine(line);
      if (stop) {
        await shutdown(0);
        return;
      }
      safePrompt();
    }
    draining = false;
    // Piped input: readline closed on EOF and we've now drained every queued line.
    if (closed) await shutdown(0);
  };

  rl.prompt();
  rl.on("line", (raw) => {
    queue.push(raw);
    void drain();
  });
  rl.on("close", () => {
    // EOF (piped input ends). Mark closed so safePrompt is a no-op; drain finishes the
    // queue and then exits. If nothing is in flight, exit now.
    closed = true;
    if (!draining) void drain();
  });
  rl.on("SIGINT", () => {
    console.log("\n(use /exit to quit)");
    safePrompt();
  });
}

main().catch((err) => {
  console.error("chat host crashed:");
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
