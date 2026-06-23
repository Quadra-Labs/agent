// serve.ts — run an example agent as an HTTP service (GET /ping, POST /chat) over the app's REAL
// intake / seal / payment loop, pointed at the engines configured in app/.env. The HTTP analog of
// run.ts (which is the interactive REPL). Reuses the app's exported runHttpAgent, so there is no
// app -> framework dependency. Needs a model key + WALRUS_SIGNER_KEY in app/.env.
//
// Run:
//   npm run serve:example -- --agent price-range
//   npm run serve:example -- --agent poly-price
//
// Set AGENT_PUBLIC_URL so the web can discover it, or use `npm run tunnel:example` to get a
// public URL automatically.

import { runHttpAgent } from "../../app/src/runtime/runHttpAgent.js";
import { loadAppEnv, parseAgentName, resolveExample } from "./registry.js";

async function main(): Promise<void> {
  const agentName = parseAgentName(process.argv.slice(2));
  // Load env BEFORE resolving the agent: the per-agent override file (app/.env.<name>) carries this
  // agent's own signer + port, the shared app/.env carries the model key + service URLs.
  loadAppEnv(agentName);
  const entry = resolveExample(agentName);
  await runHttpAgent({
    character: entry.character,
    ...(entry.produce !== undefined ? { produce: entry.produce } : {}),
  });
}

main().catch((err) => {
  console.error("serve:example crashed:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
