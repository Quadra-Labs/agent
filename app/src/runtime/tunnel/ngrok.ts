// ngrok.ts — open an ngrok tunnel to the local agent port and resolve its public HTTPS URL.
// `ngrok http <port>` (plus `--domain` for a reserved domain). The authtoken comes from the
// NGROK_AUTHTOKEN env var if set, otherwise from ngrok's own config (`ngrok config
// add-authtoken`). The robust way to read the assigned URL is ngrok's local API at
// http://127.0.0.1:4040/api/tunnels — NOT parsing the TUI/stdout, which is not parse-stable.
// ngrok is a native binary, so spawn with shell:false.

import { spawn } from "node:child_process";
import { killTree } from "./killTree.js";
import { resolveBinary } from "./resolveBinary.js";
import { MissingBinaryError, type TunnelHandle, type TunnelStartOptions } from "./types.js";

const API_URL = "http://127.0.0.1:4040/api/tunnels";
const URL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 400;

const INSTALL_HINT = [
  "Install ngrok and add your authtoken:",
  "  macOS:   brew install ngrok",
  "  Windows: winget install --id ngrok.ngrok",
  "  Linux/other: https://ngrok.com/download",
  "  then once: ngrok config add-authtoken <token>   (or set NGROK_AUTHTOKEN)",
  "If it is installed but not on PATH, set NGROK_PATH to the full path of ngrok(.exe).",
].join("\n");

// Locations winget/choco/brew/.deb installers drop ngrok, checked when it is not on PATH.
function ngrokCandidates(): string[] {
  const list: string[] = [];
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    const programData = process.env.ProgramData;
    if (local) list.push(`${local}\\Microsoft\\WinGet\\Links\\ngrok.exe`);
    if (programData) list.push(`${programData}\\chocolatey\\bin\\ngrok.exe`);
  } else {
    list.push("/opt/homebrew/bin/ngrok", "/usr/local/bin/ngrok", "/usr/bin/ngrok");
  }
  return list;
}

interface NgrokApiTunnel {
  readonly public_url?: string;
}
interface NgrokApiResponse {
  readonly tunnels?: readonly NgrokApiTunnel[];
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Poll ngrok's local agent API until an https tunnel is registered, or time out.
async function waitForNgrokUrl(): Promise<string | undefined> {
  const deadline = Date.now() + URL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(API_URL);
      if (res.ok) {
        const body = (await res.json()) as NgrokApiResponse;
        const tunnel = (body.tunnels ?? []).find((t) => t.public_url?.startsWith("https://"));
        if (tunnel?.public_url) return tunnel.public_url;
      }
    } catch {
      // API not up yet (ngrok still starting) — keep polling.
    }
    await delay(POLL_INTERVAL_MS);
  }
  return undefined;
}

export function startNgrok(opts: TunnelStartOptions): Promise<TunnelHandle> {
  return new Promise((resolve, reject) => {
    const authtoken = process.env.NGROK_AUTHTOKEN?.trim();
    const domain = process.env.NGROK_DOMAIN?.trim();
    const args = ["http", String(opts.port), ...(domain ? ["--domain", domain] : [])];

    const bin = resolveBinary("ngrok", process.env.NGROK_PATH, ngrokCandidates());
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: authtoken ? { ...process.env, NGROK_AUTHTOKEN: authtoken } : process.env,
    });

    let settled = false;
    let resolveExited!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => {
      resolveExited = r;
    });
    const stop = (): void => killTree(child.pid);

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(err.code === "ENOENT" ? new MissingBinaryError("ngrok", INSTALL_HINT) : err);
    });

    child.on("exit", (code) => {
      resolveExited(code);
      if (!settled) {
        settled = true;
        reject(new Error(`ngrok exited (code ${code ?? "null"}) before a tunnel appeared`));
      }
    });

    // Forward ngrok's logs (also surfaces auth errors) so the user can see what happened.
    child.stdout?.on("data", (d: Buffer) => opts.onLog?.(d.toString().trimEnd()));
    child.stderr?.on("data", (d: Buffer) => opts.onLog?.(d.toString().trimEnd()));

    void waitForNgrokUrl().then((url) => {
      if (settled) return;
      if (!url) {
        settled = true;
        stop();
        reject(new Error("ngrok started but no https tunnel appeared on 127.0.0.1:4040 within 30s"));
        return;
      }
      settled = true;
      resolve({ url, stop, exited });
    });
  });
}
