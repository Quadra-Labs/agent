// competitionJob.ts — the agent's FREE competition-job path. When the competition engine pushes
// a `competition_job` (competitionSocket.ts), the agent does the work and delivers the sealed
// result WITHOUT any payment: no intake session, no payment-first gate, no delivery poll. It is
// a thin parallel path that reuses the exact same result helpers as the paid lifecycle
// (produceAndSealResult -> registerSealedResult), so the encryption/delivery contract is
// identical; only the trigger and the lack of payment differ. NEVER throws; never logs secrets
// or the result bytes.

import type { IAgentRuntime } from "@elizaos/core";
import type { Signer } from "@mysten/sui/cryptography";

import type { AgentConfig } from "../runtime/config.js";
import { parseIntakeTemplates } from "../templates/intakeTemplate.js";
import { produceAndSealResult, type ProduceHook } from "./jobResult.js";
import { registerSealedResult } from "../quadra/dataGatewayClient.js";
import type { CompetitionJobEvent } from "../quadra/competitionSocket.js";

// Narrow the free-form config.walrusNetwork to the Seal client's network union (mirrors
// jobLifecycle.ts's narrowNetwork).
function narrowNetwork(n: string): "testnet" | "mainnet" | "devnet" | "localnet" {
  return n === "mainnet" || n === "devnet" || n === "localnet" ? n : "testnet";
}

export interface RunCompetitionJobInput {
  readonly runtime: IAgentRuntime;
  readonly config: AgentConfig;
  /** The agent signer; its address is the registered, enrolled agent and the result's owner. */
  readonly signer: Signer;
  /** The pushed free job. */
  readonly event: CompetitionJobEvent;
  /** Optional result producer (e.g. a trading skill). When set it REPLACES the default LLM
   * producer, exactly as in the paid lifecycle. */
  readonly produce?: ProduceHook;
  /** Injectable clock (tests). Defaults to Date.now. */
  readonly now?: () => number;
}

export type RunCompetitionJobResult =
  | { ok: true; blobId: string; jobId: string }
  // The pushed template did not parse into an intake-ready template (engine/template bug).
  | { ok: false; kind: "bad_template"; message: string; retryable: false }
  // Producing or sealing the result failed (see jobResult.ts kinds); retryable per `retryable`.
  | { ok: false; kind: "produce_failed"; message: string; retryable: boolean }
  // Registering the sealed result with the data gateway failed.
  | { ok: false; kind: "register_failed"; message: string; retryable: boolean };

/**
 * Run one free competition job to delivery. Parses the pushed data-layer template into an
 * IntakeTemplate, produces + Seal-encrypts the result under id = hex(job_id) (reusing
 * produceAndSealResult), and registers the ciphertext with the data gateway (registerSealedResult)
 * so the competition engine can later decrypt and score it. In the single-wallet model the
 * envelope's user == agent. NEVER throws; returns a typed outcome.
 */
export async function runCompetitionJob(
  input: RunCompetitionJobInput,
): Promise<RunCompetitionJobResult> {
  const { event } = input;

  // The engine sends the raw data-layer JobTemplate; reuse the agent's own parser (it accepts a
  // single-element array) so the result schema/evaluator/lifetime are validated the same way the
  // paid menu validates them.
  const parsed = parseIntakeTemplates([event.template]);
  if (!parsed.ok || parsed.templates.length === 0) {
    const reason = parsed.ok ? (parsed.skipped[0]?.reason ?? "no intake-ready template") : parsed.message;
    return { ok: false, kind: "bad_template", message: reason, retryable: false };
  }
  const template = parsed.templates[0];

  // Build the produce inputs from the pushed params. For PERFORMANCE (trading) jobs the engine
  // also sends the starting portfolio; expose it to the producer (the default LLM prompt or a
  // trading produce hook) as a JSON string so the result can reference it.
  const collected: Record<string, string> = { ...event.params };
  if (event.portfolio !== undefined) {
    collected.portfolio = JSON.stringify(event.portfolio);
  }

  const agentAddress = input.signer.toSuiAddress();
  const sealed = await produceAndSealResult(input.runtime, {
    jobId: event.job_id,
    template,
    collected,
    packageId: input.config.sealPackageId,
    keyServerIds: input.config.sealKeyServerIds,
    threshold: input.config.sealThreshold,
    network: narrowNetwork(input.config.walrusNetwork),
    ...(input.produce !== undefined ? { produce: input.produce } : {}),
    // Single-wallet model: the agent is the result's only owning party (no paying user).
    agentAddress,
    userAddress: agentAddress,
    lifetime: event.lifetime,
    startedAtMs: event.started_at_ms,
    ...(input.now ? { now: input.now } : {}),
  });
  if (!sealed.ok) {
    return { ok: false, kind: "produce_failed", message: sealed.message, retryable: sealed.retryable };
  }

  const registered = await registerSealedResult({
    baseUrl: input.config.dataGatewayUrl,
    signer: input.signer,
    jobId: event.job_id,
    ciphertext: sealed.ciphertext,
    ...(input.now ? { now: input.now } : {}),
  });
  if (!registered.ok) {
    return { ok: false, kind: "register_failed", message: registered.message, retryable: registered.retryable };
  }

  return { ok: true, blobId: registered.blobId, jobId: event.job_id };
}
