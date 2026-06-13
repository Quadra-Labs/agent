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

import type { WalrusStoreResult } from "../../plugins/plugin-walrus/src/types.js";
import type { JobTemplate } from "./templates.js";

// plugin-groq swallows API errors into this sentinel. Treat it as a hard failure so we
// never encrypt a fake "result". Lifted from chat.ts / intakeNotification.ts.
const GROQ_ERROR_SENTINEL = "Error generating text. Please try again later.";

// --- 1. Produce the real result (one model call, validated to the output schema) ---

/** The produced job result: an object whose keys/types match job_template.output. */
export type JobResult = Record<string, string | number>;

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
  template: JobTemplate,
  collected: Record<string, string>,
): string {
  const schemaLines = Object.entries(template.job_template.output)
    .map(([key, type]) => `  - ${key} (${type})`)
    .join("\n");
  const inputLines = Object.entries(collected)
    .map(([key, value]) => `  - ${key}: ${value}`)
    .join("\n");
  return [
    `Produce the result for a "${template.title}" job, using the inputs below.`,
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

// Parse + validate the model output against job_template.output. Pure. Slices the first
// {...} span so a fenced/prose-wrapped reply still parses. Any deviation from the schema
// (parse failure, missing key, extra key, wrong primitive type) -> ok:false invalid.
function parseResult(
  output: JobTemplate["job_template"]["output"],
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

/**
 * Produce the real job result via ONE structured model call and validate it against the
 * template's job_template.output schema. Returns ok:true + the conforming result, or a
 * typed failure (model_error for a failed/empty LLM call, invalid_result for off-schema
 * output). NEVER throws. The result object is NOT logged here (the caller decides).
 */
export async function produceResult(
  runtime: IAgentRuntime,
  template: JobTemplate,
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
  const parsed = parseResult(template.job_template.output, text);
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
  /** The result to encrypt (serialized to JSON bytes). */
  readonly result: JobResult;
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
// identity is the hex of the job id's UTF-8 bytes. Exported for the proof to assert the
// exact binding rather than re-deriving it.
export function jobIdToSealId(jobId: string): string {
  return toHex(new TextEncoder().encode(jobId));
}

/**
 * Seal-encrypt the result JSON under id = hex(jobId), packageId = the deployed quadra
 * package, using the open-mode key servers. Returns ok:true + ciphertext + the sealId
 * used (the binding), config_error for missing package/servers, or seal_error for an SDK
 * / key-server failure. NEVER throws. The plaintext result and the symmetric backup key
 * (encrypt() also returns `key`) are NEVER logged or returned — only the ciphertext.
 */
export async function sealEncryptResult(input: SealEncryptInput): Promise<SealEncryptResult> {
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

// --- 3. produce -> encrypt -> store (the single entry point) -----------------------

// The Walrus surface this module drives, narrowed to store() only. Mirrors templates.ts:
// app depends on the runtime CONTRACT (getService("walrus")), not the plugin class.
type WalrusLike = {
  store(bytes: Uint8Array): Promise<WalrusStoreResult>;
};

function resolveWalrus(runtime: IAgentRuntime): WalrusLike | undefined {
  const resolved = runtime.getService("walrus");
  if (resolved === undefined || resolved === null) return undefined;
  return resolved as unknown as WalrusLike;
}

export interface StoreJobResultInput {
  /** The on-chain job id; the Seal identity binds to it (and to the access record). */
  readonly jobId: string;
  /** The matched template (its job_template.output is the result schema). */
  readonly template: JobTemplate;
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
}

export type StoreJobResultResult =
  | { ok: true; blobId: string; sealId: string }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "model_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "invalid_result"; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "seal_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "blob_unavailable"; errorName: string; message: string; retryable: false };

/**
 * The job-is-done write path: produce the real result, Seal-encrypt it under the job_id,
 * and store the ciphertext on Walrus. Each stage short-circuits with its own typed kind;
 * a Walrus store failure maps the underlying WalrusStoreResult kind straight through.
 * NEVER throws, NEVER logs the result/key bytes. On success returns the durable blobId
 * plus the sealId (the encrypt-time binding) so the caller can record where the result
 * lives and under which identity it was sealed.
 */
export async function storeJobResult(
  runtime: IAgentRuntime,
  input: StoreJobResultInput,
): Promise<StoreJobResultResult> {
  if (input.packageId === undefined || input.packageId.trim().length === 0) {
    return {
      ok: false,
      kind: "config_error",
      errorName: "MissingSealPackageId",
      message: "SEAL_PACKAGE_ID is not set; job result not encrypted/stored",
      retryable: false,
    };
  }
  const walrus = resolveWalrus(runtime);
  if (walrus === undefined) {
    return {
      ok: false,
      kind: "config_error",
      errorName: "WalrusServiceUnavailable",
      message: "walrus service is not registered",
      retryable: false,
    };
  }

  const produced = await produceResult(runtime, input.template, input.collected);
  if (!produced.ok) return produced;

  const encrypted = await sealEncryptResult({
    jobId: input.jobId,
    packageId: input.packageId,
    keyServerIds: input.keyServerIds,
    threshold: input.threshold,
    result: produced.result,
    network: input.network,
  });
  if (!encrypted.ok) return encrypted;

  const stored = await walrus.store(encrypted.ciphertext);
  if (!stored.ok) {
    // Map the typed Walrus store failure through unchanged (network_error / config_error).
    return {
      ok: false,
      kind: stored.kind,
      errorName: stored.errorName,
      message: stored.message,
      retryable: stored.retryable,
    } as StoreJobResultResult;
  }
  return { ok: true, blobId: stored.blobId, sealId: encrypted.sealId };
}
