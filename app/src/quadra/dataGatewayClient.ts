// dataGatewayClient.ts — typed client for the Quadra data gateway's result-registration
// endpoint (data/src/server.ts: POST /job-results, guarded by requireAgent +
// requireRegistered). The agent encrypts the result client-side, then hands the
// gateway ONLY the base64 ciphertext envelope; the GATEWAY writes it to Walrus with its
// own signer and indexes job_id -> blobId (data/src/seal.ts storeSealed) so the
// validator can later find and decrypt it. Same signed-message auth as the intake
// engine. NEVER throws; never logs the key or the ciphertext.

import type { Signer } from "@mysten/sui/cryptography";

import { sendQuadraSignedRequest, errorMessage, isStale } from "./quadraSignedRequest.js";

export interface RegisterSealedResultInput {
  readonly baseUrl: string;
  readonly signer: Signer;
  /** The on-chain job id; the gateway indexes the result under it. */
  readonly jobId: string;
  /** The Seal ciphertext bytes (from sealEncryptResult). Base64-encoded here. */
  readonly ciphertext: Uint8Array;
  /** Abort timeout in ms. The gateway writes the blob to Walrus synchronously (tens of
   * seconds on testnet), so this must be generous; defaults to 90s here. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export type RegisterSealedResultResult =
  | { ok: true; blobId: string }
  | { ok: false; kind: "unauthorized"; errorName: string; message: string; retryable: boolean }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  // 5xx: the gateway failed to write the blob to Walrus (transient). Retry.
  | { ok: false; kind: "server_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "unexpected_status"; errorName: string; message: string; retryable: false };

/**
 * POST /job-results — register the sealed result by job_id. Returns the gateway's
 * Walrus blobId on 200, or a typed failure. The request body is the SealedResultBlob
 * `{ sealed: true, job_id, enc }` (data/src/types.ts), with `enc` the base64 ciphertext.
 * NEVER throws.
 */
export async function registerSealedResult(
  input: RegisterSealedResultInput,
): Promise<RegisterSealedResultResult> {
  const res = await sendQuadraSignedRequest({
    signer: input.signer,
    baseUrl: input.baseUrl,
    path: "/job-results",
    payload: {
      sealed: true,
      job_id: input.jobId,
      enc: Buffer.from(input.ciphertext).toString("base64"),
    },
    timeoutMs: input.timeoutMs ?? 90_000,
    now: input.now,
  });
  if (!res.ok) return res; // network_error passes straight through

  if (res.status === 200) {
    const blobId = (res.json as { blobId?: unknown } | null)?.blobId;
    if (typeof blobId === "string" && blobId.length > 0) return { ok: true, blobId };
    return {
      ok: false,
      kind: "unexpected_status",
      errorName: "UnexpectedStatus",
      message: "gateway 200 without a blobId",
      retryable: false,
    };
  }
  if (res.status === 401) {
    const message = errorMessage(res.json) || "unauthorized";
    return { ok: false, kind: "unauthorized", errorName: "Unauthorized", message, retryable: isStale(message) };
  }
  if (res.status >= 500) {
    return {
      ok: false,
      kind: "server_error",
      errorName: "GatewayServerError",
      message: errorMessage(res.json) || `gateway responded ${res.status}`,
      retryable: true,
    };
  }
  return {
    ok: false,
    kind: "unexpected_status",
    errorName: "UnexpectedStatus",
    message: `gateway responded ${res.status}${errorMessage(res.json) ? `: ${errorMessage(res.json)}` : ""}`,
    retryable: false,
  };
}
