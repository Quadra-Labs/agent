// intakeClient.ts — typed client for the Quadra intake-engine (intake-engine/src/server.ts).
// Three calls the agent makes: submitJob (POST /jobs, mints the session), deliverJob
// (POST /deliver, claims delivery), and intakeHealth (GET /health, reachability). Every
// call returns a typed ok/kind union mirroring jobResult.ts and NEVER throws. Auth is the
// shared signed-message scheme via quadraSignedRequest; the key is never logged.

import type { Signer } from "@mysten/sui/cryptography";

import {
  sendQuadraSignedRequest,
  getQuadraJson,
  errorMessage,
  isStale,
} from "./quadraSignedRequest.js";

// The session the engine mints for a submitted job. The user pays
// pay_for_job(session_id, job_id, agent_wallet, cost) on-chain against these.
export interface IntakeSession {
  readonly session_id: string;
  readonly job_id: string;
  readonly agent_wallet: string;
  readonly cost: number;
}

export interface IntakeHealth {
  readonly ok: boolean;
  readonly network?: string;
  readonly pending?: number;
  readonly active?: number;
}

export type SubmitJobResult =
  | { ok: true; session: IntakeSession }
  // 400: unknown template / bad lifetime / cost<=0. A logic/config error, not retryable.
  | { ok: false; kind: "bad_request"; errorName: string; message: string; retryable: false }
  // 401: missing/bad signature, unregistered agent (not retryable), or a stale
  // timestamp (retryable — re-sign with a fresh ts).
  | { ok: false; kind: "unauthorized"; errorName: string; message: string; retryable: boolean }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "unexpected_status"; errorName: string; message: string; retryable: false };

export type DeliverJobResult =
  // 200: the engine answered. released:false is NOT an error — it carries the engine's
  // reason ("unknown job" / "job is not releasable" / "invalid result" / "job is settling").
  | { ok: true; released: boolean; reason?: string }
  | { ok: false; kind: "unauthorized"; errorName: string; message: string; retryable: boolean }
  // 502: validator outage. Retry later.
  | { ok: false; kind: "validator_unavailable"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "unexpected_status"; errorName: string; message: string; retryable: false };

export type IntakeHealthResult =
  | { ok: true; health: IntakeHealth }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "unexpected_status"; errorName: string; message: string; retryable: false };

export interface SubmitJobInput {
  readonly baseUrl: string;
  readonly signer: Signer;
  readonly templateId: string;
  readonly lifetime: string;
  readonly cost: number;
  /** The asset the job targets (e.g. "BTC"); must be allowed by the template. */
  readonly asset: string;
  readonly now?: () => number;
}

export interface DeliverJobInput {
  readonly baseUrl: string;
  readonly signer: Signer;
  readonly jobId: string;
  /** Abort timeout in ms. /deliver runs the validator (Seal decrypt + eval) and the on-chain
   * release, which takes tens of seconds, so this must be generous; defaults to 90s. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

// --- classification helpers (errorMessage / isStale shared via quadraSignedRequest) --

function asSession(json: unknown): IntakeSession | undefined {
  if (json === null || typeof json !== "object") return undefined;
  const o = json as Record<string, unknown>;
  if (
    typeof o.session_id === "string" &&
    typeof o.job_id === "string" &&
    typeof o.agent_wallet === "string" &&
    typeof o.cost === "number"
  ) {
    return {
      session_id: o.session_id,
      job_id: o.job_id,
      agent_wallet: o.agent_wallet,
      cost: o.cost,
    };
  }
  return undefined;
}

function unauthorized(json: unknown): {
  ok: false;
  kind: "unauthorized";
  errorName: string;
  message: string;
  retryable: boolean;
} {
  const message = errorMessage(json) || "unauthorized";
  return { ok: false, kind: "unauthorized", errorName: "Unauthorized", message, retryable: isStale(message) };
}

function unexpected(status: number, json: unknown): {
  ok: false;
  kind: "unexpected_status";
  errorName: string;
  message: string;
  retryable: false;
} {
  const detail = errorMessage(json);
  return {
    ok: false,
    kind: "unexpected_status",
    errorName: "UnexpectedStatus",
    message: `intake responded ${status}${detail ? `: ${detail}` : ""}`,
    retryable: false,
  };
}

// --- the calls ---------------------------------------------------------------

/**
 * POST /jobs — open a job. Returns the minted session on 200, or a typed failure
 * (bad_request / unauthorized / network_error / unexpected_status). NEVER throws.
 */
export async function submitJob(input: SubmitJobInput): Promise<SubmitJobResult> {
  const res = await sendQuadraSignedRequest({
    signer: input.signer,
    baseUrl: input.baseUrl,
    path: "/jobs",
    payload: {
      template_id: input.templateId,
      lifetime: input.lifetime,
      cost: input.cost,
      asset: input.asset,
    },
    now: input.now,
  });
  if (!res.ok) return res; // network_error passes straight through

  if (res.status === 200) {
    const session = asSession(res.json);
    if (session) return { ok: true, session };
    return unexpected(res.status, res.json);
  }
  if (res.status === 400) {
    return {
      ok: false,
      kind: "bad_request",
      errorName: "BadRequest",
      message: errorMessage(res.json) || "bad request",
      retryable: false,
    };
  }
  if (res.status === 401) return unauthorized(res.json);
  return unexpected(res.status, res.json);
}

/**
 * POST /deliver — claim delivery. A 200 (released true OR false) is success and carries
 * the engine's reason; 502 is validator_unavailable (retry). NEVER throws.
 */
export async function deliverJob(input: DeliverJobInput): Promise<DeliverJobResult> {
  const res = await sendQuadraSignedRequest({
    signer: input.signer,
    baseUrl: input.baseUrl,
    path: "/deliver",
    payload: { job_id: input.jobId },
    timeoutMs: input.timeoutMs ?? 90_000,
    now: input.now,
  });
  if (!res.ok) return res;

  if (res.status === 200) {
    const o = res.json;
    if (o !== null && typeof o === "object" && typeof (o as { released?: unknown }).released === "boolean") {
      const released = (o as { released: boolean }).released;
      const reason = (o as { reason?: unknown }).reason;
      return { ok: true, released, ...(typeof reason === "string" ? { reason } : {}) };
    }
    return unexpected(res.status, res.json);
  }
  if (res.status === 401) return unauthorized(res.json);
  if (res.status === 502) {
    return {
      ok: false,
      kind: "validator_unavailable",
      errorName: "ValidatorUnavailable",
      message: errorMessage(res.json) || "validator unavailable",
      retryable: true,
    };
  }
  return unexpected(res.status, res.json);
}

/**
 * GET /health — reachability + network/counts. NEVER throws. Used by the live proof to
 * decide whether to run (unreachable -> network_error -> the proof SKIPs).
 */
export async function intakeHealth(baseUrl: string): Promise<IntakeHealthResult> {
  const res = await getQuadraJson(baseUrl, "/health");
  if (!res.ok) return res;
  if (res.status === 200 && res.json !== null && typeof res.json === "object") {
    const o = res.json as Record<string, unknown>;
    return {
      ok: true,
      health: {
        ok: o.ok === true,
        ...(typeof o.network === "string" ? { network: o.network } : {}),
        ...(typeof o.pending === "number" ? { pending: o.pending } : {}),
        ...(typeof o.active === "number" ? { active: o.active } : {}),
      },
    };
  }
  return unexpected(res.status, res.json);
}
