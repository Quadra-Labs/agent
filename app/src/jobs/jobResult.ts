// jobResult.ts — the small app-level Seal write path (not a plugin): when a job is done,
// produce the result, Seal-encrypt it under the on-chain quadra::job_access policy, and
// store the ciphertext on Walrus. BINDING: seal_approve does string::utf8(id), so the
// Seal identity must be id = toHex(utf8Bytes(job_id)); access binds to the encrypt-time
// id, not the PTB. Three steps (produceResult -> sealEncryptResult -> storeJobResult),
// each a typed ok/kind union, never logging signer/result bytes.

import { ModelType } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import { SealClient } from "@mysten/seal";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { toHex } from "@mysten/bcs";

import type { IntakeTemplate } from "../templates/intakeTemplate.js";

// plugin-groq swallows API errors into this sentinel. Treat it as a hard failure so we
// never encrypt a fake "result". Lifted from chat.ts / intakeNotification.ts.
const GROQ_ERROR_SENTINEL = "Error generating text. Please try again later.";

// --- 1. Produce the real result (one model call, validated to the output schema) ---

/** The produced job result: an object whose keys/types match job_template.output. */
export type JobResult = Record<string, string | number>;

/** The sealed model an LLM-driven producer uses. Structural (matches the framework's LoopModel), so
 *  the app builds it from its runtime and hands it to the hook without importing the framework. */
export interface ProducerModel {
  generate(prompt: string): Promise<string>;
}

/**
 * An optional, framework-agnostic result producer. When supplied to produceAndSealResult it
 * REPLACES the default LLM producer — e.g. the example agents supply a hook that lets the MODEL
 * pick which of their skills to run (makeSkillProducer). The app only calls the callback; it knows
 * nothing about the framework. The returned result is still validated against the template's output
 * schema before sealing — so a bad result is rejected (and a weak agent simply scores low).
 */
export type ProduceHook = (args: {
  readonly template: IntakeTemplate;
  readonly collected: Record<string, string>;
  /** Present for LLM-driven producers: the model that decides which skill/strategy to run. Built
   *  from the runtime by produceAndSealResult. Fixed producers ignore it. */
  readonly model?: ProducerModel;
}) => Promise<{ ok: true; result: JobResult } | { ok: false; reason: string }>;

/**
 * The FULL plaintext envelope that gets Seal-encrypted (mirrors the data layer's JobResult).
 * The validator/scheduler decrypt this and read `job.template`, `agent_result`, `started_at`,
 * `delivered_at` — so the agent must seal the whole envelope, not just the bare agent_result.
 */
export interface JobResultEnvelope {
  readonly job_id: string;
  /** The paying user's wallet (in the single-wallet demo, equals the agent). */
  readonly user: string;
  /** The agent's wallet. */
  readonly agent: string;
  readonly status: "delivered";
  readonly job: {
    readonly lifetime: string;
    readonly template: {
      readonly id: string;
      readonly category: string;
      readonly description: string;
      readonly output: Record<string, "number" | "string">;
      /** Empty ("") for a scoreless job (no evaluator). */
      readonly evaluator_id: string;
      readonly start_data_template: Record<string, string>;
      readonly minimum_lifetime: number;
      readonly allowed_assets: readonly string[];
      /** Scoreless: paid on delivery, never scored. */
      readonly scoreless: boolean;
    };
  };
  /** The fixed job params the result was produced against (e.g. prediction's
   * `{ market_id, target_ts }`). Sealed here because the scheduler decrypts THIS envelope to
   * score a paid prediction job and forwards these to the polymarket-* evaluators (which resolve
   * ground truth from params, not a Pyth asset). Absent/empty for finance jobs (scheduler ignores
   * params for them). Mirrors the data layer's JobResult.params. */
  readonly params?: Record<string, string>;
  /** What the agent returned (shape matches template.output). */
  readonly agent_result: JobResult;
  /** Filled by the evaluation engine at scoring; empty at delivery. */
  readonly finalized_result: Record<string, unknown>;
  readonly score: number;
  /** Job clock start (the on-chain paid_at_ms). */
  readonly started_at: number;
  readonly delivered_at: number;
}

export type ProduceResultResult =
  | { ok: true; result: JobResult }
  // The model call failed outright (empty / groq sentinel). Retryable: a transient LLM
  // problem, not a schema problem.
  | { ok: false; kind: "model_error"; errorName: string; message: string; retryable: true }
  // The model returned something, but it did not conform to job_template.output (not
  // JSON, missing a field, or a field of the wrong primitive type). NOT retryable as-is.
  | { ok: false; kind: "invalid_result"; errorName: string; message: string; retryable: false };

// A leak-guarded prompt: the model gets the collected inputs and the OUTPUT schema and
// must return ONLY a flat JSON object with exactly the schema's keys. It never sees the
// raw template object, so it cannot echo internal fields.
function buildResultPrompt(
  template: IntakeTemplate,
  collected: Record<string, string>,
): string {
  const schemaLines = Object.entries(template.output)
    .map(([key, type]) => `  - ${key} (${type})`)
    .join("\n");
  const inputLines = Object.entries(collected)
    .map(([key, value]) => `  - ${key}: ${value}`)
    .join("\n");
  return [
    `Produce the result for a "${template.description}" job, using the inputs below.`,
    "Output ONLY a single JSON object with EXACTLY these keys and value types:",
    schemaLines,
    "",
    "A number field must be a JSON number; a string field a JSON string. No prose, no",
    "markdown, no code fences, no extra keys -- just the raw JSON object.",
    "",
    "Inputs:",
    inputLines.length > 0 ? inputLines : "  (none collected)",
    "",
    "JSON object:",
  ].join("\n");
}

// Validate an already-parsed object against job_template.output. Pure. Any deviation from the
// schema (missing key, extra key, wrong primitive type) -> ok:false. Shared by the LLM parser
// and the produce-hook path so both enforce the exact declared shape.
function validateResultObject(
  output: IntakeTemplate["output"],
  parsed: unknown,
): { ok: true; result: JobResult } | { ok: false; message: string } {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "result was not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const expectedKeys = Object.keys(output);
  const result: Record<string, string | number> = {};
  for (const key of expectedKeys) {
    const declared = output[key];
    const value = obj[key];
    if (declared === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, message: `field "${key}" is not a finite number` };
      }
      result[key] = value;
    } else {
      if (typeof value !== "string" || value.trim().length === 0) {
        return { ok: false, message: `field "${key}" is not a non-empty string` };
      }
      result[key] = value;
    }
  }
  // Reject extra keys: the result must be EXACTLY the declared shape (the policy and the
  // evaluation engines consume this; silent extra fields would be a contract drift).
  const extra = Object.keys(obj).filter((k) => !(k in output));
  if (extra.length > 0) {
    return { ok: false, message: `result has unexpected field(s): ${extra.join(", ")}` };
  }
  return { ok: true, result };
}

// Parse + validate the model output against job_template.output. Pure. Slices the first
// {...} span so a fenced/prose-wrapped reply still parses, then validates the object.
function parseResult(
  output: IntakeTemplate["output"],
  raw: string,
): { ok: true; result: JobResult } | { ok: false; message: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, message: "no JSON object in result" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { ok: false, message: "result was not valid JSON" };
  }
  return validateResultObject(output, parsed);
}

/**
 * Produce the real job result via ONE structured model call and validate it against the
 * template's job_template.output schema. Returns ok:true + the conforming result, or a
 * typed failure (model_error for a failed/empty LLM call, invalid_result for off-schema
 * output). NEVER throws. The result object is NOT logged here (the caller decides).
 */
async function produceResult(
  runtime: IAgentRuntime,
  template: IntakeTemplate,
  collected: Record<string, string>,
): Promise<ProduceResultResult> {
  let raw: unknown;
  try {
    raw = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: buildResultPrompt(template, collected),
    });
  } catch (err) {
    return {
      ok: false,
      kind: "model_error",
      errorName: err instanceof Error ? err.constructor.name : "Error",
      message: err instanceof Error ? err.message : "model call threw",
      retryable: true,
    };
  }
  const text = (typeof raw === "string" ? raw : String(raw ?? "")).trim();
  if (text.length === 0 || text === GROQ_ERROR_SENTINEL) {
    return {
      ok: false,
      kind: "model_error",
      errorName: "ModelError",
      message: text === GROQ_ERROR_SENTINEL ? "groq error sentinel" : "empty model response",
      retryable: true,
    };
  }
  const parsed = parseResult(template.output, text);
  if (!parsed.ok) {
    return {
      ok: false,
      kind: "invalid_result",
      errorName: "InvalidResult",
      message: parsed.message,
      retryable: false,
    };
  }
  return { ok: true, result: parsed.result };
}

// --- 2. Seal-encrypt the result under id = hex(job_id) -----------------------------

export interface SealEncryptInput {
  /** The on-chain job id (UTF-8). Becomes the Seal identity = toHex(utf8(jobId)). */
  readonly jobId: string;
  /** The deployed `quadra` package id (0x...): the Seal packageId namespace. */
  readonly packageId: string;
  /** Open-mode key server object ids (config.sealKeyServerIds). */
  readonly keyServerIds: readonly string[];
  /** TSS threshold (config.sealThreshold). */
  readonly threshold: number;
  /** The value to encrypt (serialized to JSON bytes) — the full JobResultEnvelope. */
  readonly result: unknown;
  /** Sui network for the read-only JSON-RPC client the SealClient needs. */
  readonly network: "testnet" | "mainnet" | "devnet" | "localnet";
}

export type SealEncryptResult =
  | { ok: true; ciphertext: Uint8Array; sealId: string }
  // Misconfiguration (no package id, no key servers): not retryable until config is set.
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false }
  // The Seal SDK / key-server interaction failed (network, server down). Retryable.
  | { ok: false; kind: "seal_error"; errorName: string; message: string; retryable: true };

// Map the UTF-8 job id to the Seal identity bytes the on-chain seal_approve expects.
// seal_approve does string::utf8(id); @mysten/seal hex-decodes the id string. So the
// identity is the hex of the job id's UTF-8 bytes.
function jobIdToSealId(jobId: string): string {
  return toHex(new TextEncoder().encode(jobId));
}

/**
 * Seal-encrypt the result JSON under id = hex(jobId), packageId = the deployed quadra
 * package, using the open-mode key servers. Returns ok:true + ciphertext + the sealId
 * used (the binding), config_error for missing package/servers, or seal_error for an SDK
 * / key-server failure. NEVER throws. The plaintext result and the symmetric backup key
 * (encrypt() also returns `key`) are NEVER logged or returned — only the ciphertext.
 */
async function sealEncryptResult(input: SealEncryptInput): Promise<SealEncryptResult> {
  const packageId = input.packageId.trim();
  if (packageId.length === 0) {
    return {
      ok: false,
      kind: "config_error",
      errorName: "MissingSealPackageId",
      message: "SEAL_PACKAGE_ID is not set; cannot encrypt under the job_access policy",
      retryable: false,
    };
  }
  const servers = input.keyServerIds.filter((s) => s.trim().length > 0);
  if (servers.length === 0) {
    return {
      ok: false,
      kind: "config_error",
      errorName: "MissingKeyServers",
      message: "no Seal key server ids configured",
      retryable: false,
    };
  }

  const sealId = jobIdToSealId(input.jobId);
  const data = new TextEncoder().encode(JSON.stringify(input.result));

  try {
    const suiClient = new SuiJsonRpcClient({
      url: getJsonRpcFullnodeUrl(input.network),
      network: input.network,
    });
    const client = new SealClient({
      // The read-only RPC client exposes `.core`, satisfying SealCompatibleClient
      // (P0c spike note). verifyKeyServers:false matches the spike's open-mode usage.
      suiClient: suiClient as unknown as ConstructorParameters<typeof SealClient>[0]["suiClient"],
      serverConfigs: servers.map((objectId) => ({ objectId, weight: 1 })),
      verifyKeyServers: false,
    });
    // encrypt() also returns the 256-bit symmetric `key` (a decryption backup). We
    // deliberately DISCARD it: keeping/logging it would bypass the on-chain policy.
    const { encryptedObject } = await client.encrypt({
      threshold: input.threshold,
      packageId,
      id: sealId,
      data,
    });
    return { ok: true, ciphertext: encryptedObject, sealId };
  } catch (err) {
    return {
      ok: false,
      kind: "seal_error",
      errorName: err instanceof Error ? err.constructor.name : "Error",
      message: err instanceof Error ? err.message : "seal encrypt failed",
      retryable: true,
    };
  }
}

// --- 3. produce -> seal (the data-gateway delivery path) ---------------------------

export interface SealResultInput {
  /** The on-chain job id; the Seal identity binds to it (and to the access record). */
  readonly jobId: string;
  /** The matched template (its output is the result schema). */
  readonly template: IntakeTemplate;
  /** The collected parameter values the result is produced from. */
  readonly collected: Record<string, string>;
  /** Deployed quadra package id (config.sealPackageId). Absent -> config_error. */
  readonly packageId: string | undefined;
  /** Open-mode key server object ids (config.sealKeyServerIds). */
  readonly keyServerIds: readonly string[];
  /** TSS threshold (config.sealThreshold). */
  readonly threshold: number;
  /** Sui network for the read-only client the SealClient needs. */
  readonly network: "testnet" | "mainnet" | "devnet" | "localnet";
  /** Optional producer that REPLACES the default LLM producer (e.g. the Pyth price-range
   * skill). Its result is still validated against template.output before sealing. */
  readonly produce?: ProduceHook;
  /** The agent's wallet (envelope `agent`). */
  readonly agentAddress: string;
  /** The paying user's wallet (envelope `user`); equals the agent in the single-wallet demo. */
  readonly userAddress: string;
  /** The user-chosen lifetime, e.g. "5m" (envelope `job.lifetime`). */
  readonly lifetime: string;
  /** The job clock start = on-chain paid_at_ms (envelope `started_at`). */
  readonly startedAtMs: number;
  /** Injectable clock for delivered_at (tests). Defaults to Date.now. */
  readonly now?: () => number;
}

export type ProduceAndSealResult =
  | { ok: true; ciphertext: Uint8Array; sealId: string }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "model_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "invalid_result"; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "seal_error"; errorName: string; message: string; retryable: true };

/**
 * Produce the real result and Seal-encrypt it under id = hex(jobId), stopping at the
 * CIPHERTEXT — no Walrus write. This is the delivery path used with the data gateway:
 * the gateway (data/src/seal.ts storeSealed) does the durable Walrus write + indexing,
 * so the agent only needs the ciphertext to register via dataGatewayClient. Reuses
 * produceResult + sealEncryptResult; NEVER throws, NEVER logs the result/key bytes.
 */
export async function produceAndSealResult(
  runtime: IAgentRuntime,
  input: SealResultInput,
): Promise<ProduceAndSealResult> {
  if (input.packageId === undefined || input.packageId.trim().length === 0) {
    return {
      ok: false,
      kind: "config_error",
      errorName: "MissingSealPackageId",
      message: "SEAL_PACKAGE_ID is not set; job result not encrypted",
      retryable: false,
    };
  }

  // Produce via the injected hook (e.g. the Pyth price-range skill) when present, else the
  // default LLM producer. Either way the result is validated against template.output.
  let result: JobResult;
  if (input.produce !== undefined) {
    // The sealed model the producer may use to decide which skill/strategy to run. Lazy: it only
    // calls runtime.useModel when the producer actually generates. A non-string / empty / groq
    // sentinel response throws so we never seal a fake result.
    const model: ProducerModel = {
      generate: async (prompt: string): Promise<string> => {
        const raw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
        const text = typeof raw === "string" ? raw : String(raw ?? "");
        if (text.trim().length === 0 || text.trim() === GROQ_ERROR_SENTINEL) {
          throw new Error("model returned an empty/sentinel response");
        }
        return text;
      },
    };
    const produced = await input.produce({
      template: input.template,
      collected: input.collected,
      model,
    });
    if (!produced.ok) {
      return {
        ok: false,
        kind: "model_error",
        errorName: "ProducerError",
        message: produced.reason,
        retryable: true,
      };
    }
    const validated = validateResultObject(input.template.output, produced.result);
    if (!validated.ok) {
      return {
        ok: false,
        kind: "invalid_result",
        errorName: "InvalidResult",
        message: validated.message,
        retryable: false,
      };
    }
    result = validated.result;
  } else {
    const produced = await produceResult(runtime, input.template, input.collected);
    if (!produced.ok) return produced;
    result = produced.result;
  }

  // Wrap the produced agent_result in the FULL envelope the validator/scheduler decrypt + read.
  const t = input.template;
  const envelope: JobResultEnvelope = {
    job_id: input.jobId,
    user: input.userAddress,
    agent: input.agentAddress,
    status: "delivered",
    job: {
      lifetime: input.lifetime,
      template: {
        id: t.id,
        category: t.category,
        description: t.description,
        output: t.output,
        evaluator_id: t.evaluator_id,
        start_data_template: {},
        minimum_lifetime: t.minimumLifetimeMs ?? 0,
        allowed_assets: t.allowedAssets ?? [],
        scoreless: t.scoreless,
      },
    },
    // The collected param values the result was produced against. For a paid prediction job these
    // (market_id / target_ts) are the ONLY carrier of the evaluator's ground-truth inputs into the
    // scheduler, which scores by decrypting this envelope. Sealed for every job; only prediction
    // scoring reads them (scheduler buildPayload gates on category === "prediction").
    params: { ...input.collected },
    agent_result: result,
    finalized_result: {},
    score: 0,
    started_at: input.startedAtMs,
    delivered_at: (input.now ?? Date.now)(),
  };

  const encrypted = await sealEncryptResult({
    jobId: input.jobId,
    packageId: input.packageId,
    keyServerIds: input.keyServerIds,
    threshold: input.threshold,
    result: envelope,
    network: input.network,
  });
  if (!encrypted.ok) return encrypted;

  return { ok: true, ciphertext: encrypted.ciphertext, sealId: encrypted.sealId };
}
