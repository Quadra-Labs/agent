// tunnel.ts — `npm run tunnel`: give a locally-running agent a public HTTPS URL so the
// Quadra web can discover + chat with it and the on-chain "Register agent" flow can ping it.
// By default this opens a tunnel to AGENT_PORT, captures the public URL, then launches the
// HTTP agent (serve) as a child with AGENT_PUBLIC_URL wired in, and probes /ping to confirm
// the path works end to end. With --print-url it opens the tunnel, prints the URL, and stops
// there (you run chat/serve yourself). Ctrl-C tears down the tunnel and the agent together.
//
// Run:
//   npm run tunnel                          # cloudflare quick tunnel + serve (one command)
//   npm run tunnel -- --provider ngrok      # ngrok instead (needs NGROK_AUTHTOKEN)
//   npm run tunnel -- --print-url           # tunnel only, print the URL, don't start serve
//   npm run tunnel -- --character example   # passthrough to serve
//
// The agent's connections to the engines (intake/competition sockets, data gateway) are
// OUTBOUND and need no public URL — only the inbound /ping + /chat path does.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAgentConfig } from "./config.js";
import { killTree } from "./tunnel/killTree.js";
import { startCloudflared } from "./tunnel/cloudflared.js";
import { startNgrok } from "./tunnel/ngrok.js";
import { MissingBinaryError, type TunnelHandle } from "./tunnel/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, "..", "..");
const SERVE_SCRIPT = resolve(here, "serve.ts");

type Provider = "cloudflare" | "ngrok";

// Load app/.env into process.env if present (tsx does not auto-load it). Same shape as cli.ts.
function loadDotEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader(".env");
  } catch {
    // No .env file — rely on whatever is already in the environment.
  }
}

interface TunnelArgs {
  readonly provider: Provider;
  readonly port: number | undefined;
  /** false when --print-url / --no-serve is passed: open the tunnel but do not launch serve. */
  readonly serve: boolean;
  readonly characterRef: string | undefined;
  readonly help: boolean;
}

// Parse `--provider`, `--port`, `--print-url`/`--no-serve`, `--character`, `--help`. The
// default provider is TUNNEL_PROVIDER (cloudflare unless it says ngrok). Unknown flags are
// ignored, matching cli.ts.
function parseArgs(argv: readonly string[]): TunnelArgs {
  let provider: Provider =
    process.env.TUNNEL_PROVIDER?.trim().toLowerCase() === "ngrok" ? "ngrok" : "cloudflare";
  let port: number | undefined;
  let serve = true;
  let characterRef: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--provider" && i + 1 < argv.length) {
      const value = argv[i + 1].toLowerCase();
      if (value !== "cloudflare" && value !== "ngrok") {
        console.error(`Unknown provider "${argv[i + 1]}" — use cloudflare or ngrok.`);
        process.exit(1);
      }
      provider = value;
      i += 1;
    } else if (arg === "--port" && i + 1 < argv.length) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error("--port must be a positive integer.");
        process.exit(1);
      }
      port = parsed;
      i += 1;
    } else if (arg === "--print-url" || arg === "--no-serve") {
      serve = false;
    } else if ((arg === "--character" || arg === "-c") && i + 1 < argv.length) {
      characterRef = argv[i + 1];
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    }
  }
  return { provider, port, serve, characterRef, help };
}

function printHelp(): void {
  console.log(`npm run tunnel — expose a local agent on a public HTTPS URL.

Usage:
  npm run tunnel [-- <flags>]

Flags:
  --provider <cloudflare|ngrok>  Tunnel provider (default: cloudflare, or TUNNEL_PROVIDER).
  --port <n>                     Local port to forward (default: AGENT_PORT, 3939).
  --print-url, --no-serve        Open the tunnel and print the URL; do not start serve.
  --character, -c <ref>          Passed through to serve.
  -h, --help                     Show this help.`);
}

let shuttingDown = false;

// Tear down both children (tunnel + serve) and their process trees, then exit. Idempotent.
// The unref'd timer is a backstop so a stuck child can never hang the shutdown.
function shutdown(children: ReadonlyArray<{ stop: () => void }>, code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nShutting down tunnel and agent...");
  for (const child of children) {
    try {
      child.stop();
    } catch {
      // Best-effort: the child may already be gone.
    }
  }
  setTimeout(() => process.exit(code), 1500).unref();
}

function installSignals(children: ReadonlyArray<{ stop: () => void }>): void {
  process.on("SIGINT", () => shutdown(children, 0));
  process.on("SIGTERM", () => shutdown(children, 0));
}

// Poll <publicUrl>/ping until it returns { ok: true } or the timeout elapses. Confirms the
// tunnel actually reaches the agent. Node 20+ has a global fetch.
async function waitForPing(publicUrl: string, timeoutMs = 40_000, intervalMs = 1000): Promise<boolean> {
  const target = `${publicUrl.replace(/\/+$/, "")}/ping`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(target);
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        if (body?.ok === true) return true;
      }
    } catch {
      // Tunnel or agent not ready yet — keep polling.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function logChild(name: string, line: string): void {
  if (line.trim().length > 0) console.log(`[${name}] ${line}`);
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const config = loadAgentConfig();
  const port = args.port ?? config.agentPort;
  const { provider } = args;

  console.log(`Opening a ${provider} tunnel to http://localhost:${port} ...`);
  let handle: TunnelHandle;
  try {
    handle =
      provider === "ngrok"
        ? await startNgrok({ port, onLog: (l) => logChild("ngrok", l) })
        : await startCloudflared({ port, onLog: (l) => logChild("cloudflared", l) });
  } catch (err) {
    if (err instanceof MissingBinaryError) {
      console.error(`\n${err.bin} is not installed or not on your PATH.\n`);
      console.error(err.installHint);
      if (provider === "cloudflare") {
        console.error("\nOr use ngrok instead:  npm run tunnel -- --provider ngrok");
      }
      process.exit(1);
    }
    throw err;
  }

  // Quick/ngrok tunnels report their URL; a Cloudflare named/token tunnel does not, so fall
  // back to the operator-supplied AGENT_PUBLIC_URL.
  const publicUrl = handle.url ?? config.agentPublicUrl;
  if (!publicUrl) {
    console.error("\nTunnel is up but its public URL is unknown.");
    console.error("A Cloudflare named/token tunnel has an external hostname — set AGENT_PUBLIC_URL in .env.");
    handle.stop();
    process.exit(1);
  }

  console.log(`\n  Public URL:  ${publicUrl}\n`);

  // Quick tunnels (and ngrok without a reserved domain) hand out a fresh URL every run.
  const ephemeral =
    handle.url !== undefined &&
    (provider === "ngrok" ? !process.env.NGROK_DOMAIN?.trim() : !process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim());
  if (ephemeral) {
    console.log("  Note: this URL is temporary and changes every run. Re-register and re-publish");
    console.log("  the agent whenever it changes. For a stable address use a Cloudflare named");
    console.log("  tunnel (CLOUDFLARE_TUNNEL_TOKEN + AGENT_PUBLIC_URL) or ngrok with NGROK_DOMAIN.\n");
  }

  const children: Array<{ stop: () => void }> = [{ stop: handle.stop }];
  installSignals(children);

  if (!args.serve) {
    console.log(`AGENT_PUBLIC_URL=${publicUrl}`);
    console.log("Tunnel only (--print-url). Start the agent in another terminal, e.g.:");
    console.log(`  AGENT_PUBLIC_URL=${publicUrl} npm run serve`);
    console.log("Press Ctrl-C to close the tunnel.");
    void handle.exited.then((code) => {
      if (!shuttingDown) shutdown(children, code ?? 0);
    });
    await handle.exited;
    return;
  }

  console.log(`Starting the agent (serve) with AGENT_PUBLIC_URL=${publicUrl} ...\n`);
  const serveChild = spawn(
    process.execPath,
    ["--import", "tsx", SERVE_SCRIPT, ...(args.characterRef ? ["--character", args.characterRef] : [])],
    {
      stdio: "inherit",
      cwd: APP_ROOT,
      shell: false,
      env: { ...process.env, AGENT_PUBLIC_URL: publicUrl, AGENT_PORT: String(port) },
    },
  );
  children.push({ stop: () => killTree(serveChild.pid) });

  serveChild.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`\nAgent (serve) exited (code ${code ?? 0}).`);
      shutdown(children, code ?? 1);
    }
  });
  void handle.exited.then((code) => {
    if (!shuttingDown) {
      console.error(`\nTunnel exited (code ${code ?? 0}).`);
      shutdown(children, code ?? 1);
    }
  });

  const reachable = await waitForPing(publicUrl);
  if (shuttingDown) return;
  if (reachable) {
    console.log(`\n  /ping reachable through the tunnel — your agent is live at ${publicUrl}\n`);
  } else {
    console.warn("\n  Could not reach /ping through the tunnel yet. Likely causes:");
    console.warn("   - the agent is still booting (model/runtime init)");
    console.warn("   - the agent failed to start (see its logs above)");
    console.warn(`   - AGENT_PORT mismatch (the tunnel targets port ${port})\n`);
  }
}

main().catch((err) => {
  console.error("tunnel crashed:");
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
