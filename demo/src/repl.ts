// Interactive terminal loop. Anything that is not a /command is routed to the
// agent (respond). Slash-commands let a teammate SEE each memory tier:
//   /history  -> the local SQLite chat tier (listTurns)
//   /close    -> write a checkpoint to MemWal on Walrus, then start a fresh session
//   /resume   -> recall the latest MemWal checkpoint and continue from it
//   /sessions -> list recorded checkpoints
// The framing strings make explicit which tier each action touches.

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { IAgentRuntime } from "@elizaos/core";
import { listTurns } from "./chatMemory.js";
import { respond } from "./agent.js";
import { writeCheckpoint, readCheckpoint } from "./memwal.js";
import { latestCheckpoint, loadState } from "./state.js";
import { WalrusHttpError, type WalrusHttpConfig } from "./walrusHttp.js";

export interface ReplDeps {
  readonly runtime: IAgentRuntime;
  readonly walrusCfg: WalrusHttpConfig;
  /** Readable job descriptions for the system prompt (never shown to the user). */
  readonly templatesText: string;
  /** Called on /exit or /quit to tear down the runtime before process exit. */
  readonly stop: () => Promise<void>;
}

const HELP = [
  "Commands:",
  "  /help      Show this list",
  "  /history   Show this session's chat as stored in the local SQLite DB",
  "  /close     Write a session checkpoint to MemWal (Walrus), then start fresh",
  "  /resume    Recall the latest MemWal checkpoint and continue from it",
  "  /sessions  List checkpoints recorded on Walrus",
  "  /exit      Stop the agent and quit (alias: /quit)",
  "Anything else you type is sent to the agent.",
].join("\n");

function newRoomId(): string {
  return `session-${randomUUID()}`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function walrusErrorLine(err: unknown): string {
  if (err instanceof WalrusHttpError) {
    const status = err.status !== undefined ? ` (HTTP ${err.status})` : "";
    return `Walrus error${status}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the REPL until the user exits. Holds mutable session state (current room +
 * any recalled summary) locally; everything durable goes through the foundation
 * APIs. Resolves after the runtime has been stopped.
 */
export async function runRepl(deps: ReplDeps): Promise<void> {
  const { runtime, walrusCfg, templatesText, stop } = deps;
  const rl = createInterface({ input: stdin, output: stdout });

  let roomId = newRoomId();
  // Set after /resume so subsequent agent turns carry the recalled context.
  let resumedSummary: string | undefined;

  console.log(HELP);
  console.log("");
  rl.setPrompt("You: ");

  const sendToAgent = async (text: string): Promise<void> => {
    try {
      const reply = await respond(runtime, {
        roomId,
        userText: text,
        templatesText,
        resumedSummary,
      });
      console.log(`Agent: ${reply}\n`);
    } catch (err) {
      console.log(`(agent error) ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };

  const handleHistory = async (): Promise<void> => {
    const turns = await listTurns(runtime, roomId);
    console.log("Chat history stored in the local SQLite DB:");
    if (turns.length === 0) {
      console.log("  (this session has no turns yet)\n");
      return;
    }
    for (const turn of turns) {
      const who = turn.role === "agent" ? "Agent" : "User";
      console.log(`  [${who}] ${turn.text}`);
    }
    console.log("");
  };

  const handleClose = async (): Promise<void> => {
    try {
      const { blobId, preview } = await writeCheckpoint(runtime, walrusCfg, roomId);
      console.log(
        `Session closed. Checkpoint written to MemWal on Walrus testnet (blobId: ${blobId}).`,
      );
      console.log(`Summary: ${preview}`);
      roomId = newRoomId();
      resumedSummary = undefined;
      console.log("Started a fresh session. Type /resume to continue from that checkpoint.\n");
    } catch (err) {
      console.log(`Could not close session: ${walrusErrorLine(err)}\n`);
    }
  };

  const handleResume = async (): Promise<void> => {
    const latest = await latestCheckpoint();
    if (!latest) {
      console.log("No checkpoints recorded yet. Use /close to write one first.\n");
      return;
    }
    try {
      const checkpoint = await readCheckpoint(walrusCfg, latest.blobId);
      roomId = newRoomId();
      resumedSummary = checkpoint.summary;
      console.log(
        `Recalled checkpoint ${latest.blobId} from MemWal. The agent will continue from here.`,
      );
      console.log("");
      // Visibly show the agent reading the recalled context. The opener is an
      // internal cue; the user sees only the agent's acknowledgement.
      await sendToAgent(
        "(You have just recalled our previous session. Greet me, briefly recap " +
          "where we left off, and continue.)",
      );
    } catch (err) {
      console.log(`Could not recall checkpoint: ${walrusErrorLine(err)}\n`);
    }
  };

  const handleSessions = async (): Promise<void> => {
    const { checkpoints } = await loadState();
    console.log("Checkpoints recorded on Walrus (MemWal tier):");
    if (checkpoints.length === 0) {
      console.log("  (none yet -- use /close to write one)\n");
      return;
    }
    checkpoints.forEach((cp, i) => {
      console.log(`  ${i + 1}. blobId ${cp.blobId}  [${fmtTime(cp.createdAt)}]`);
      console.log(`     ${cp.preview}`);
    });
    console.log("");
  };

  // Buffered line input that works for an interactive human AND for piped/scripted
  // stdin. Lines are queued as they arrive (so none are lost while the body awaits
  // a slow LLM reply), and stdin EOF (Ctrl-D or a pipe closing) ends the loop
  // cleanly via a null sentinel -- never throwing "readline was closed".
  const pending: string[] = [];
  let waiting: ((line: string | null) => void) | null = null;
  let closed = false;
  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      pending.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(null);
    }
  });
  const nextLine = (): Promise<string | null> => {
    if (pending.length > 0) return Promise.resolve(pending.shift() ?? null);
    if (closed) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      waiting = resolve;
    });
  };
  const showPrompt = (): void => {
    if (!closed) rl.prompt();
  };

  try {
    showPrompt();
    for (;;) {
      const rawLine = await nextLine();
      if (rawLine === null) break;

      const trimmed = rawLine.trim();
      if (trimmed.length === 0) {
        showPrompt();
        continue;
      }

      const command = trimmed.toLowerCase();
      if (command === "/exit" || command === "/quit") break;

      if (command === "/help") {
        console.log(`${HELP}\n`);
      } else if (command === "/history") {
        await handleHistory();
      } else if (command === "/close") {
        await handleClose();
      } else if (command === "/resume") {
        await handleResume();
      } else if (command === "/sessions") {
        await handleSessions();
      } else if (command.startsWith("/")) {
        console.log(`Unknown command: ${trimmed}. Type /help for the list.\n`);
      } else {
        await sendToAgent(trimmed);
      }

      showPrompt();
    }
    console.log("Shutting down. Goodbye.");
  } finally {
    rl.close();
    await stop();
  }
}
