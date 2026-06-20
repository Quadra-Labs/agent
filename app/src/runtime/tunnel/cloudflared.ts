// cloudflared.ts — open a Cloudflare tunnel to the local agent port and resolve its public
// HTTPS URL. Two modes:
//   - Quick tunnel (default, no account): `cloudflared tunnel --url http://localhost:<port>`
//     assigns an ephemeral https://<random>.trycloudflare.com URL, printed to STDERR. We
//     scan the output for it (the classic gotcha is watching stdout, where it never appears).
//   - Named/token tunnel (stable): set CLOUDFLARE_TUNNEL_TOKEN -> `cloudflared tunnel run
//     --token <token>`. The hostname is configured in the token's ingress, not printed, so
//     we return url: undefined and the caller supplies AGENT_PUBLIC_URL.
// cloudflared is a native .exe, so spawn with shell:false (PATHEXT resolves it on Windows).

import { spawn } from "node:child_process";
import { killTree } from "./killTree.js";
import { resolveBinary } from "./resolveBinary.js";
import { MissingBinaryError, type TunnelHandle, type TunnelStartOptions } from "./types.js";

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const URL_TIMEOUT_MS = 30_000;

const INSTALL_HINT = [
  "Install cloudflared:",
  "  macOS:   brew install cloudflared",
  "  Windows: winget install --id Cloudflare.cloudflared",
  "  Linux/other: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
  "If it is installed but not on PATH, set CLOUDFLARED_PATH to the full path of cloudflared(.exe).",
].join("\n");

// Locations winget/MSI/brew/.deb installers drop cloudflared, checked when it is not on PATH.
function cloudflaredCandidates(): string[] {
  const list: string[] = [];
  if (process.platform === "win32") {
    const pf86 = process.env["ProgramFiles(x86)"];
    const pf = process.env.ProgramFiles;
    const local = process.env.LOCALAPPDATA;
    if (pf86) list.push(`${pf86}\\cloudflared\\cloudflared.exe`);
    if (pf) list.push(`${pf}\\cloudflared\\cloudflared.exe`);
    if (local) list.push(`${local}\\Microsoft\\WinGet\\Links\\cloudflared.exe`);
  } else {
    list.push("/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared");
  }
  return list;
}

// Turn a stream of Buffer chunks into complete lines, buffering any trailing partial line.
function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buf = "";
  return (chunk: Buffer) => {
    buf += chunk.toString();
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() ?? "";
    for (const line of parts) onLine(line);
  };
}

export function startCloudflared(opts: TunnelStartOptions): Promise<TunnelHandle> {
  return new Promise((resolve, reject) => {
    const token = process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim();
    const args = token
      ? ["tunnel", "run", "--token", token]
      : ["tunnel", "--url", `http://localhost:${opts.port}`];

    const bin = resolveBinary("cloudflared", process.env.CLOUDFLARED_PATH, cloudflaredCandidates());
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });

    let settled = false;
    let resolveExited!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => {
      resolveExited = r;
    });
    const stop = (): void => killTree(child.pid);

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(err.code === "ENOENT" ? new MissingBinaryError("cloudflared", INSTALL_HINT) : err);
    });

    child.on("exit", (code) => {
      resolveExited(code);
      if (!settled) {
        settled = true;
        reject(new Error(`cloudflared exited (code ${code ?? "null"}) before a tunnel URL appeared`));
      }
    });

    // Named/token tunnel: the public hostname is external, so there is no URL to capture.
    if (token) {
      settled = true;
      resolve({ url: undefined, stop, exited });
      return;
    }

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      reject(new Error("cloudflared started but printed no trycloudflare.com URL within 30s"));
    }, URL_TIMEOUT_MS);
    timeout.unref();

    const scan = lineSplitter((line) => {
      opts.onLog?.(line);
      if (settled) return;
      const match = line.match(QUICK_URL_RE);
      if (match) {
        settled = true;
        clearTimeout(timeout);
        resolve({ url: match[0], stop, exited });
      }
    });
    // The URL lands on stderr in practice; watch both streams to be robust across versions.
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
  });
}
