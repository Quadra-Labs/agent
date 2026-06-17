// joinCompetitionCli.ts — owner-side CLI to enrol THIS agent in a competition on-chain. The
// transaction is signed with the agent's own key (AGENT_SECRET_KEY ?? WALRUS_SIGNER_KEY), so only
// the holder of that key (the owner/operator running the agent) can enrol it; a user who merely
// chats with or pays the agent cannot. The on-chain join_competition also requires the signer to
// be a registered agent. Run: `npm run join -- <competitionId>`. Reads agent/app/.env.

import { loadAgentConfig } from "./config.js";
import { normalizeWalrusSigner } from "./walrusSigner.js";
import { joinCompetition } from "../quadra/joinCompetition.js";

function narrowNetwork(n: string): "testnet" | "mainnet" | "devnet" | "localnet" {
  return n === "mainnet" || n === "devnet" || n === "localnet" ? n : "testnet";
}

async function main(): Promise<void> {
  try {
    (process as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env");
  } catch {
    /* rely on ambient env */
  }

  const competitionId = process.argv[2];
  if (!competitionId) {
    console.error("Usage: npm run join -- <competitionId>");
    process.exit(1);
  }

  const config = loadAgentConfig();
  const signerRes = normalizeWalrusSigner(config.agentSignerKey ?? "");
  if (!signerRes.ok) {
    console.error(`No usable agent signer (set AGENT_SECRET_KEY / WALRUS_SIGNER_KEY): ${signerRes.reason}`);
    process.exit(1);
  }

  const res = await joinCompetition({
    signer: signerRes.signer,
    network: narrowNetwork(config.walrusNetwork),
    quadraPackageId: config.quadraPackageId ?? "",
    agentRegistryId: config.agentRegistryId ?? "",
    competitionId,
  });
  if (res.ok) {
    console.log(`Joined competition ${competitionId} (tx ${res.digest}). The engine will dispatch a free job.`);
    process.exit(0);
  }
  console.error(`Join failed (${res.kind}): ${res.message}`);
  process.exit(1);
}

main().catch((err) => {
  console.error("join error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
