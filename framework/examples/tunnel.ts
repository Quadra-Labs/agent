// tunnel.ts — open a public Cloudflare (default) or ngrok tunnel to AGENT_PORT, then serve an
// example agent on it with AGENT_PUBLIC_URL wired in so the Quadra web can discover, ping, and
// chat with it. The framework analog of the app's `npm run tunnel`, but for the example agents.
// Reuses the app's tunnel providers + runHttpAgent (framework -> app is allowed; not the reverse).
//
// Run:
//   npm run tunnel:example -- --agent price-range
//   npm run tunnel:example -- --agent poly-price --provider ngrok
//
// Needs a model key + WALRUS_SIGNER_KEY in app/.env, and the engine URLs (INTAKE_URL,
// DATA_GATEWAY_URL) pointed at the real engines. Ctrl-C tears down the tunnel and the agent.

import { loadAgentConfig } from "../../app/src/runtime/config.js";
import { runHttpAgent } from "../../app/src/runtime/runHttpAgent.js";
import { startCloudflared } from "../../app/src/runtime/tunnel/cloudflared.js";
import { startNgrok } from "../../app/src/runtime/tunnel/ngrok.js";
import { MissingBinaryError, type TunnelHandle } from "../../app/src/runtime/tunnel/types.js";
import { loadAppEnv, parseAgentName, resolveExample } from "./registry.js";

type Provider = "cloudflare" | "ngrok";

function parseProvider(argv: readonly string[]): Provider {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--provider" && i + 1 < argv.length) {
      const value = argv[i + 1].toLowerCase();
      if (value !== "cloudflare" && value !== "ngrok") {
        console.error(`Unknown provider "${argv[i + 1]}" — use cloudflare or ngrok.`);
        process.exit(1);
      }
      return value;
    }
  }
  return process.env.TUNNEL_PROVIDER?.trim().toLowerCase() === "ngrok" ? "ngrok" : "cloudflare";
}

function parsePort(argv: readonly string[]): number | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port" && i + 1 < argv.length) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error("--port must be a positive integer.");
        process.exit(1);
      }
      return parsed;
    }
  }
  return undefined;
}

// Poll <publicUrl>/ping until it answers ok, or time out. Non-fatal: a failure here is usually
// the local DNS resolver, not the tunnel (the wider internet still reaches the agent).
async function waitForPing(publicUrl: string, timeoutMs = 40_000, intervalMs = 1500): Promise<boolean> {
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
      // not reachable yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const agentName = parseAgentName(argv);
  // Load env BEFORE resolving the agent: the per-agent override file (app/.env.<name>) carries this
  // agent's own signer + port, the shared app/.env carries the model key + service URLs. Without
  // the name the per-agent WALRUS_SIGNER_KEY / AGENT_PORT never load (empty signer, port clash).
  loadAppEnv(agentName);
  const entry = resolveExample(agentName);
  const config = loadAgentConfig();
  const port = parsePort(argv) ?? config.agentPort;
  const provider = parseProvider(argv);

  console.log(`Opening a ${provider} tunnel to http://localhost:${port} ...`);
  // The tunnel binaries are very chatty (cloudflared prints dozens of INF lines per boot). They
  // are noise during normal use — the public URL is captured and printed separately below — so
  // forward them only when DEBUG is on in app/.env (DEBUG=1/true). The URL capture inside
  // startCloudflared is independent of this callback, so muting it never breaks URL detection.
  const debugLogs = ["1", "true", "yes"].includes((process.env.DEBUG ?? "").trim().toLowerCase());
  const tunnelLog = (tag: string) => (l: string): void => {
    if (debugLogs && l.trim()) console.log(`[${tag}] ${l}`);
  };
  let handle: TunnelHandle;
  try {
    handle =
      provider === "ngrok"
        ? await startNgrok({ port, onLog: tunnelLog("ngrok") })
        : await startCloudflared({ port, onLog: tunnelLog("cloudflared") });
  } catch (err) {
    if (err instanceof MissingBinaryError) {
      console.error(`\n${err.bin} is not installed or not on your PATH.\n`);
      console.error(err.installHint);
      if (provider === "cloudflare") {
        console.error("\nOr use ngrok instead:  npm run tunnel:example -- --provider ngrok --agent <name>");
      }
      process.exit(1);
    }
    throw err;
  }

  const publicUrl = handle.url ?? config.agentPublicUrl;
  if (!publicUrl) {
    console.error("\nTunnel is up but its public URL is unknown.");
    console.error("A Cloudflare named/token tunnel has an external hostname — set AGENT_PUBLIC_URL in app/.env.");
    handle.stop();
    process.exit(1);
  }

  console.log(`\n  Public URL:  ${publicUrl}\n`);

  // Wire the env runHttpAgent reads (it calls loadAgentConfig() internally on boot).
  process.env.AGENT_PUBLIC_URL = publicUrl;
  process.env.AGENT_PORT = String(port);

  // Stop the tunnel on shutdown. runHttpAgent registers its own SIGINT/SIGTERM that closes the
  // server, stops the runtime, and exits; this handler (registered first) kills the tunnel tree.
  const stopTunnel = (): void => {
    try {
      handle.stop();
    } catch {
      // best-effort
    }
  };
  process.on("SIGINT", stopTunnel);
  process.on("SIGTERM", stopTunnel);
  void handle.exited.then(() => {
    console.warn("\n(tunnel exited — the agent is no longer reachable on the public URL)");
  });

  // runHttpAgent resolves once the HTTP server is listening (the process stays alive on the
  // server handle), so we can probe the public /ping afterwards to confirm the path.
  await runHttpAgent({
    character: entry.character,
    ...(entry.produce !== undefined ? { produce: entry.produce } : {}),
  });

  const reachable = await waitForPing(publicUrl);
  if (reachable) {
    console.log(`\n  /ping reachable through the tunnel — your agent is live at ${publicUrl}\n`);
  } else {
    console.warn("\n  Could not reach /ping through the tunnel from this machine. This is usually a");
    console.warn("  local DNS resolver issue (the wider internet still reaches it). The agent is up");
    console.warn(`  locally on port ${port}.\n`);
  }
}

main().catch((err) => {
  console.error("tunnel:example crashed:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
