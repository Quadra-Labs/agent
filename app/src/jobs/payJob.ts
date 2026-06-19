// payJob.ts — the dApp's pay_for_job step, performed by the agent HOST so a chat-driven job
// settles its escrow with no separate frontend or terminal. It locks `cost` QUADRA from the
// payer signer into the job's on-chain Escrow (emitting JobPaid, which the intake engine watches
// to release the agent to start the work). On a successful delivery the intake engine releases
// the escrow to the agent; on failure/expiry it refunds — the agent never touches the funds.
//
// Mirrors joinCompetition.ts's transaction pattern (build a Transaction, signAndExecute, check
// effects) and competition/scripts/pay-job.ts's coin selection (merge + split the exact cost).
// In the single-wallet demo the payer IS the agent signer (the deployer wallet holds the QUADRA
// supply); a real multi-user product would sign this with the paying USER's wallet via a dApp.
// NEVER throws; never logs the key.

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import type { Signer } from "@mysten/sui/cryptography";

export interface PayForJobInput {
  /** The payer (single-wallet demo: the agent's own funded signer). */
  readonly signer: Signer;
  readonly network: "testnet" | "mainnet" | "devnet" | "localnet";
  /** Deployed `quadra` package id (config.quadraPackageId); also the QUADRA coin type namespace. */
  readonly quadraPackageId: string;
  /** Shared `agent::AgentRegistry` object id (config.agentRegistryId). */
  readonly agentRegistryId: string;
  /** Shared `job_access::JobAccessRegistry` object id (config.jobAccessRegistryId). */
  readonly jobAccessRegistryId: string;
  /** The intake session minted at submit. */
  readonly sessionId: string;
  readonly jobId: string;
  /** The agent's wallet the escrow is keyed to (session.agent_wallet). */
  readonly agentWallet: string;
  /** Cost in QUADRA base units (session.cost). */
  readonly cost: number;
  /** Optional Sui RPC URL override; defaults to the network fullnode. */
  readonly suiRpcUrl?: string;
}

export type PayForJobResult =
  | { ok: true; digest: string }
  // A required id is missing or the cost is non-positive — a config error, not retryable.
  | { ok: false; kind: "config_error"; message: string }
  // The on-chain call failed (no/low QUADRA, already paid, RPC error). Surfaced, not thrown.
  | { ok: false; kind: "tx_error"; message: string };

/**
 * Lock `cost` QUADRA from `signer` into the job's escrow via
 * `quadra::intake::pay_for_job`. Returns the tx digest on success, or a typed failure. NEVER
 * throws; never logs the signer. The intake engine's JobPaidWatcher observes the emitted JobPaid
 * and pushes `job_paid` to the agent, which then produces + delivers (payment-first).
 */
export async function payForJob(input: PayForJobInput): Promise<PayForJobResult> {
  const pkg = input.quadraPackageId.trim();
  const agentRegistry = input.agentRegistryId.trim();
  const accessRegistry = input.jobAccessRegistryId.trim();
  if (pkg.length === 0) return { ok: false, kind: "config_error", message: "QUADRA_PACKAGE_ID is not set" };
  if (agentRegistry.length === 0) return { ok: false, kind: "config_error", message: "AGENT_REGISTRY_ID is not set" };
  if (accessRegistry.length === 0)
    return { ok: false, kind: "config_error", message: "JOB_ACCESS_REGISTRY_ID is not set" };
  if (!(input.cost > 0)) return { ok: false, kind: "config_error", message: "cost must be positive" };

  const url = (input.suiRpcUrl ?? "").trim() || getJsonRpcFullnodeUrl(input.network);
  const client = new SuiJsonRpcClient({ url, network: input.network });
  const quadraType = `${pkg}::quadra::QUADRA`;
  const costN = BigInt(Math.round(input.cost));
  const payerAddr = input.signer.toSuiAddress();

  try {
    const coins = await client.getCoins({ owner: payerAddr, coinType: quadraType });
    if (coins.data.length === 0) {
      return { ok: false, kind: "tx_error", message: `payer holds no ${quadraType} coins` };
    }
    const sorted = [...coins.data].sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));
    const total = sorted.reduce((s, c) => s + BigInt(c.balance), 0n);
    if (total < costN) {
      return { ok: false, kind: "tx_error", message: `insufficient QUADRA: have ${total}, need ${costN}` };
    }

    const tx = new Transaction();
    const primary = tx.object(sorted[0]!.coinObjectId);
    // Merge smaller coins into the primary when the largest cannot cover the cost on its own.
    if (BigInt(sorted[0]!.balance) < costN && sorted.length > 1) {
      tx.mergeCoins(
        primary,
        sorted.slice(1).map((c) => tx.object(c.coinObjectId)),
      );
    }
    const [payment] = tx.splitCoins(primary, [tx.pure.u64(costN)]);
    tx.moveCall({
      target: `${pkg}::intake::pay_for_job`,
      arguments: [
        tx.object(agentRegistry),
        tx.object(accessRegistry),
        tx.pure.string(input.sessionId),
        tx.pure.string(input.jobId),
        tx.pure.address(input.agentWallet),
        payment!,
        tx.object("0x6"), // the shared Clock
      ],
    });

    const res = await client.signAndExecuteTransaction({
      signer: input.signer,
      transaction: tx,
      options: { showEffects: true },
    });
    if (res.effects?.status.status !== "success") {
      return { ok: false, kind: "tx_error", message: res.effects?.status.error ?? "pay_for_job failed" };
    }
    return { ok: true, digest: res.digest };
  } catch (err) {
    return { ok: false, kind: "tx_error", message: err instanceof Error ? err.message : "pay_for_job failed" };
  }
}
