// registerAgent.ts — register this agent's wallet on the on-chain AgentRegistry. Required once
// per published package (republishing mints a fresh, empty registry). The agent's signer address
// becomes the agent id; the intake/competition engines + data gateway reject unregistered agents.
// Run: `npm run register` (optionally `-- --name "X" --category finance`). Add `--scoreless`
// (or AGENT_SCORELESS=1) for a scoreless agent: paid on delivery, never scored, cannot compete.
// The scoreless flag is FIXED at registration — it cannot be changed later. Reads agent/app/.env.

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";

import { loadAgentConfig } from "./config.js";
import { normalizeWalrusSigner } from "./walrusSigner.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function narrowNetwork(n: string): "testnet" | "mainnet" | "devnet" | "localnet" {
  return n === "mainnet" || n === "devnet" || n === "localnet" ? n : "testnet";
}

async function main(): Promise<void> {
  try {
    (process as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env");
  } catch {
    /* rely on ambient env */
  }
  const config = loadAgentConfig();
  const pkg = (config.quadraPackageId ?? "").trim();
  const registry = (config.agentRegistryId ?? "").trim();
  if (!pkg) throw new Error("QUADRA_PACKAGE_ID (or SEAL_PACKAGE_ID) is not set in agent/app/.env");
  if (!registry) throw new Error("AGENT_REGISTRY_ID is not set in agent/app/.env");

  const signerRes = normalizeWalrusSigner(config.agentSignerKey ?? "");
  if (!signerRes.ok) throw new Error(`no usable agent signer: ${signerRes.reason}`);
  const signer = signerRes.signer;
  const addr = signer.toSuiAddress();

  const name = arg("name", "Quadra Agent");
  const description = arg("description", "A Quadra agent");
  const category = arg("category", "finance");
  const scoreless = flag("scoreless") || /^(1|true|yes)$/i.test(process.env.AGENT_SCORELESS ?? "");

  const client = new SuiJsonRpcClient({
    network: narrowNetwork(config.walrusNetwork),
    url: config.walrusSuiRpcUrl.trim() || getJsonRpcFullnodeUrl(narrowNetwork(config.walrusNetwork)),
  });

  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg}::agent::register_agent`,
    arguments: [
      tx.object(registry),
      tx.pure.address(addr),
      tx.pure.string(name),
      tx.pure.string(description),
      tx.pure.string(category),
      tx.pure.bool(scoreless),
    ],
  });

  const res = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true },
  });
  if (res.effects?.status.status !== "success") {
    throw new Error(`register_agent failed: ${res.effects?.status.error ?? "unknown"}`);
  }
  console.log(
    `Registered agent ${addr} (category=${category}${scoreless ? ", scoreless" : ""}) tx ${res.digest}.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("register error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
