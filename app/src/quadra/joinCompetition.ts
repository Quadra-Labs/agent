// joinCompetition.ts — the agent's on-chain enrolment in a competition. Builds and submits
// `competition::join_competition(competition, registry)` with the agent signer; the competition
// engine watches the emitted `AgentJoined` event for a verifiable participant list and then
// dispatches free jobs to the agent. Mirrors the intake engine's Payments transaction pattern
// (build a Transaction, signAndExecuteTransaction, check effects). NEVER throws; never logs the
// key.

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import type { Signer } from "@mysten/sui/cryptography";

export interface JoinCompetitionInput {
  readonly signer: Signer;
  readonly network: "testnet" | "mainnet" | "devnet" | "localnet";
  /** The deployed `quadra` package id (config.quadraPackageId). */
  readonly quadraPackageId: string;
  /** The shared `agent::AgentRegistry` object id (config.agentRegistryId). */
  readonly agentRegistryId: string;
  /** The shared `competition::Competition` object id to join. */
  readonly competitionId: string;
  /** Optional Sui RPC URL override; defaults to the network fullnode. */
  readonly suiRpcUrl?: string;
}

export type JoinCompetitionResult =
  | { ok: true; digest: string }
  // A required id is missing (package / registry / competition not configured).
  | { ok: false; kind: "config_error"; message: string }
  // The transaction failed (already joined, not registered, ended, or RPC error).
  | { ok: false; kind: "tx_error"; message: string };

/**
 * Enrol the agent in `competitionId` on-chain. Returns the tx digest on success, or a typed
 * failure. A re-join aborts on-chain with `EAlreadyJoined` and surfaces here as `tx_error`
 * (idempotent from the caller's view — the agent is already enrolled). NEVER throws.
 */
export async function joinCompetition(input: JoinCompetitionInput): Promise<JoinCompetitionResult> {
  const pkg = input.quadraPackageId.trim();
  const registry = input.agentRegistryId.trim();
  const competition = input.competitionId.trim();
  if (pkg.length === 0) return { ok: false, kind: "config_error", message: "QUADRA_PACKAGE_ID is not set" };
  if (registry.length === 0) return { ok: false, kind: "config_error", message: "AGENT_REGISTRY_ID is not set" };
  if (competition.length === 0) return { ok: false, kind: "config_error", message: "competition id is empty" };

  const url = (input.suiRpcUrl ?? "").trim() || getJsonRpcFullnodeUrl(input.network);
  const client = new SuiJsonRpcClient({ url, network: input.network });

  // Submit with a few retries: a flaky connection can throw a transient "fetch failed" on the
  // Sui RPC call. A Move abort (e.g. EAlreadyJoined) or resolution failure is deterministic, so
  // it is returned immediately and never retried. A fresh Transaction is built per attempt.
  const MAX_ATTEMPTS = 4;
  let lastMessage = "join failed";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${pkg}::competition::join_competition`,
      arguments: [tx.object(competition), tx.object(registry)],
    });
    try {
      const res = await client.signAndExecuteTransaction({
        signer: input.signer,
        transaction: tx,
        options: { showEffects: true },
      });
      if (res.effects?.status.status !== "success") {
        return { ok: false, kind: "tx_error", message: res.effects?.status.error ?? "join failed" };
      }
      return { ok: true, digest: res.digest };
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : "join failed";
      const transient =
        /fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang|network|timed? ?out/i.test(
          lastMessage,
        ) && !/abort|resolution failed|insufficient/i.test(lastMessage);
      if (!transient || attempt === MAX_ATTEMPTS) {
        return { ok: false, kind: "tx_error", message: lastMessage };
      }
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
    }
  }
  return { ok: false, kind: "tx_error", message: lastMessage };
}
