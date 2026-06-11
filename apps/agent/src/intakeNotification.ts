// intakeNotification.ts — A4 Task 5: CONSTRUCT (do NOT sign) the Intake notification.
//
// When a job has every parameter collected, the framework builds the notification
// the Intake Engine would receive. This module CONSTRUCTS that object and LOGS it.
// It NEVER signs it and NEVER sends it — signing/sending is a different workstream
// and the cross-workstream wire interfaces are not yet locked (see PROVISIONAL).
//
// Two pieces:
//   1. buildIntakeNotification(...) — a PURE builder over already-known inputs. No
//      model, no wallet, no Walrus. Unit-testable with synthetic inputs (Task 5 done
//      bar). Returns the four-field notification.
//   2. completeIntake(...) — the on-completion path: extract the collected parameter
//      VALUES from the chat transcript via ONE structured useModel call (leak-guarded
//      prompt), build the notification via (1), and LOG it. Never signs/sends.
//
// The `job_template` field carries the matched template's REAL { output, lifetime }
// (the canonical team-contract shape, lifted from templates.ts). The other three
// fields are PROVISIONAL stubs (see the type doc) until the cross-workstream
// identity/job-id interfaces are locked.

import { ModelType } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";

import { flattenTranscript } from "./closeSession.js";
import type { ChatTurn } from "./chatMemory.js";
import type { JobTemplate } from "./templates.js";
import { storeJobResult } from "./jobResult.js";
import type { StoreJobResultResult } from "./jobResult.js";

// plugin-groq swallows API errors and returns this sentinel instead of throwing.
// Treat it as a hard extraction failure so we never build a notification from a fake
// "extraction". Lifted from chat.ts / closeSession.ts.
const GROQ_ERROR_SENTINEL = "Error generating text. Please try again later.";

// --- The notification shape (CONSTRUCTED, never signed) ----------------------
//
// The object the Intake Engine would receive. `job_template` is REAL (the matched
// template's canonical { output, lifetime }). The other three fields are PROVISIONAL
// stubs: the cross-workstream interfaces that produce a real user wallet address,
// agent identity, and job id are NOT yet locked. They are clearly marked so a later
// task can replace the stubs without guessing their intent.
export interface IntakeNotification {
  /**
   * PROVISIONAL: the user's wallet address. Currently the session `user` stub passed
   * in. The real on-chain wallet-address interface is not yet locked cross-workstream.
   */
  readonly user_wallet: string;
  /** REAL: the matched template's canonical contract shape { output, lifetime }. */
  readonly job_template: JobTemplate["job_template"];
  /**
   * PROVISIONAL: a local stub job id (e.g. "job-<category_id>-<uuid>"). The real
   * job-id interface (issued by the Intake Engine / settlement layer) is not yet
   * locked cross-workstream.
   */
  readonly job_id: string;
  /**
   * PROVISIONAL: the agent's identity. Currently the runtime agent-name stub. The
   * real agent-identity interface (on-chain agent id / registration) is not yet
   * locked cross-workstream.
   */
  readonly agent_id: string;
}

export interface BuildIntakeInput {
  /** PROVISIONAL user-wallet stub (the session `user`). */
  readonly userWallet: string;
  /** The matched template; its real { output, lifetime } becomes job_template. */
  readonly template: JobTemplate;
  /** PROVISIONAL agent-identity stub (the runtime agent name). */
  readonly agentId: string;
  /**
   * OPTIONAL deterministic id source for the job_id stub. Injectable so the pure
   * builder is fully deterministic under test (no Date.now / random). Defaults to a
   * timestamp+random suffix when omitted.
   */
  readonly idSuffix?: string;
}

// --- Pure builder (no model, no wallet, no I/O — Task 5 unit bar) ------------

/**
 * Build the four-field Intake notification from already-known inputs. PURE: no model,
 * no wallet, no Walrus, no logging. `job_template` is the matched template's REAL
 * { output, lifetime }; `user_wallet`/`agent_id` pass the provided stubs through;
 * `job_id` is a local stub "job-<category_id>-<suffix>" (suffix injectable for
 * determinism). Unit-asserted with synthetic inputs in matchProof.ts.
 */
export function buildIntakeNotification(input: BuildIntakeInput): IntakeNotification {
  const suffix =
    input.idSuffix ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    user_wallet: input.userWallet,
    job_template: input.template.job_template,
    job_id: `job-${input.template.category_id}-${suffix}`,
    agent_id: input.agentId,
  };
}

// --- On-completion extraction path (uses the model; logs, never signs) -------

// Extract the collected parameter VALUES the user gave, keyed by the template's param
// names. A leak-guarded structured prompt: it must reason over the template's param
// names internally but the OUTPUT is a flat JSON object of name -> value strings (or
// null when not yet given). This is the ONLY model call on this path.
function buildExtractionPrompt(template: JobTemplate, transcript: string): string {
  const paramLines = Object.entries(template.params)
    .map(([name, p]) => `  - ${name} (${p.type}): asked as "${p.ask}"`)
    .join("\n");
  return [
    "From the conversation below, extract the value the user gave for each job",
    "parameter. Output ONLY a single JSON object mapping each parameter name to the",
    "user's value as a string, or null if the user has not given it yet. No prose, no",
    "markdown, no code fences -- just the raw JSON object.",
    "",
    "Parameters to extract:",
    paramLines,
    "",
    "Conversation:",
    transcript,
    "",
    "JSON object:",
  ].join("\n");
}

// Parse the model's extraction output into a name -> value map, tolerating a fenced
// or prose-wrapped reply by slicing the first {...} span. Unknown/invalid shapes
// yield an empty map (the caller still builds the notification; values are best-effort
// extraction). Pure.
export function parseExtractedParams(raw: string): Record<string, string> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const entries = Object.entries(parsed as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
    .map(([k, v]) => [k, (v as string).trim()] as const);
  return Object.fromEntries(entries);
}

/**
 * OPTIONAL config that turns on the "job is done -> write the result to Seal" path. When
 * present, completeIntake produces the real result, encrypts it under the job's id, and
 * stores the ciphertext on Walrus (see jobResult.ts). When ABSENT, completeIntake behaves
 * exactly as in A4 (construct + log the notification only) — the Seal write is strictly
 * additive and opt-in so the A4 gate stays byte-identical.
 */
export interface SealWriteConfig {
  /** Deployed quadra package id (config.sealPackageId). Absent here disables the write. */
  readonly packageId: string | undefined;
  /** Open-mode key server object ids (config.sealKeyServerIds). */
  readonly keyServerIds: readonly string[];
  /** TSS threshold (config.sealThreshold). */
  readonly threshold: number;
  /** Sui network for the read-only client SealClient needs. */
  readonly network: "testnet" | "mainnet" | "devnet" | "localnet";
}

export interface CompleteIntakeInput {
  /** The matched template the job conforms to. */
  readonly template: JobTemplate;
  /** The session transcript (oldest-first) the values are extracted from. */
  readonly turns: readonly ChatTurn[];
  /** PROVISIONAL user-wallet stub (the session `user`). */
  readonly userWallet: string;
  /** PROVISIONAL agent-identity stub (the runtime agent name). */
  readonly agentId: string;
  /** OPTIONAL deterministic id suffix for the job_id stub (test injection). */
  readonly idSuffix?: string;
  /**
   * OPTIONAL. When set, the result is produced, Seal-encrypted under the constructed
   * job_id, and stored on Walrus after the notification is built. Absent -> no Seal
   * write (A4 behavior). The Seal identity binds to the SAME job_id the notification
   * carries, so the write is governed by quadra::job_access for that exact job.
   */
  readonly sealWrite?: SealWriteConfig;
}

export interface CompleteIntakeResult {
  /** The CONSTRUCTED notification (logged, never signed/sent). */
  readonly notification: IntakeNotification;
  /** The collected parameter values extracted from the transcript (best-effort). */
  readonly collected: Record<string, string>;
  /**
   * The outcome of the "write the result to Seal" step, or undefined when no sealWrite
   * config was supplied. A typed ok/kind union (never a throw): on success it carries the
   * durable blobId and the sealId the result was encrypted under; on failure, the typed
   * reason. The caller decides how to surface a failed result-write — the notification
   * itself is unaffected.
   */
  readonly resultWrite?: StoreJobResultResult;
}

/**
 * On-completion path: extract the collected parameter values from the transcript via
 * ONE structured useModel call (leak-guarded), build the four-field notification via
 * buildIntakeNotification, LOG it, and return it. NEVER signs, NEVER sends. Throws
 * only if the extraction model call itself fails (empty / groq sentinel) — a genuine
 * precondition error, distinct from "a parameter value was missing" (which surfaces
 * as that param being absent from `collected`).
 */
export async function completeIntake(
  runtime: IAgentRuntime,
  input: CompleteIntakeInput,
): Promise<CompleteIntakeResult> {
  const transcript = flattenTranscript(input.turns);
  const raw = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: buildExtractionPrompt(input.template, transcript),
  });
  const text = (typeof raw === "string" ? raw : String(raw ?? "")).trim();
  if (text.length === 0 || text === GROQ_ERROR_SENTINEL) {
    const why = text === GROQ_ERROR_SENTINEL ? "groq error sentinel" : "empty response";
    throw new Error(
      `Failed to extract collected parameters for the Intake notification (${why}). ` +
        "Check the Groq key/model.",
    );
  }

  const collected = parseExtractedParams(text);
  const notification = buildIntakeNotification({
    userWallet: input.userWallet,
    template: input.template,
    agentId: input.agentId,
    idSuffix: input.idSuffix,
  });

  // CONSTRUCT + LOG only. This is where a different workstream would sign and send;
  // the framework deliberately stops here. The notification carries no secret.
  console.log(`Intake notification constructed (NOT signed/sent): ${JSON.stringify(notification)}`);

  // The job is done -> write the result to Seal, if (and only if) sealWrite is supplied.
  // The Seal identity binds to the SAME job_id the notification carries, so the
  // ciphertext is governed by quadra::job_access for this exact job. The result bytes
  // are NEVER logged here; we log only the typed outcome (blob id / failure kind).
  let resultWrite: StoreJobResultResult | undefined;
  if (input.sealWrite !== undefined) {
    resultWrite = await storeJobResult(runtime, {
      jobId: notification.job_id,
      template: input.template,
      collected,
      packageId: input.sealWrite.packageId,
      keyServerIds: input.sealWrite.keyServerIds,
      threshold: input.sealWrite.threshold,
      network: input.sealWrite.network,
    });
    if (resultWrite.ok) {
      console.log(
        `Job result encrypted to Seal and stored on Walrus: blob ${resultWrite.blobId} ` +
          `(sealed under job_id ${notification.job_id}).`,
      );
    } else {
      console.warn(
        `Job result NOT written to Seal (${resultWrite.kind}): ${resultWrite.message}. ` +
          "The Intake notification is unaffected.",
      );
    }
  }

  return { notification, collected, resultWrite };
}
