// healthServer.ts: a tiny inbound liveness endpoint for the agent process.
//
// The agent is otherwise an outbound-only client (intake socket, gateway writes).
// The web "Register agent" flow needs to confirm a deployed agent is actually live
// and that it controls the wallet being registered, so we expose GET /ping (and
// /health) returning the agent's Sui address + name. node:http only, no new deps,
// no framework. The signer secret is NEVER exposed; only the public address is.

import { createServer, type Server } from "node:http";

import type { Signer } from "@mysten/sui/cryptography";

export interface HealthServerOptions {
  readonly port: number;
  readonly host: string;
  readonly name: string;
  /** The agent lifecycle signer; its public address is reported so a validator can
   *  match it to the wallet being registered. Absent -> ready:false. */
  readonly signer?: Signer;
}

export interface HealthServerHandle {
  readonly port: number;
  readonly close: () => Promise<void>;
}

/**
 * Start the liveness server. Returns a handle (or undefined if it could not bind,
 * e.g. the port is in use). A missing health endpoint must never crash the agent.
 */
export function startHealthServer(opts: HealthServerOptions): HealthServerHandle | undefined {
  const address = opts.signer?.toSuiAddress() ?? null;

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (req.method === "GET" && (path === "/ping" || path === "/health")) {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      res.end(
        JSON.stringify({
          ok: true,
          service: "quadra-agent",
          name: opts.name,
          address,
          ready: address !== null,
          ts: Date.now(),
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json", ...cors });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  server.on("error", (err) => {
    console.warn(`(health server not started: ${err instanceof Error ? err.message : String(err)})`);
  });

  server.listen(opts.port, opts.host);

  return {
    port: opts.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
