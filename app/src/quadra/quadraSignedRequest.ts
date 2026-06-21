// quadraSignedRequest.ts — the ONE client-side helper for the Quadra signed-message
// auth scheme, shared by every Quadra service (intake-engine /jobs + /deliver, data
// gateway /job-results). The scheme (verified server-side in intake-engine/src/auth.ts
// and data/src/auth.ts): serialize the body ONCE, sign the Sui personal message
// `${ts}.${body}`, and send the EXACT same body string with x-quadra-ts + x-quadra-sig.
// The server captures the raw bytes and verifies against them, so the string that is
// signed and the string that is sent MUST be byte-identical — hence serialize once.
//
// Deliberately NOT the framework http.ts LoopHttp: that throws on non-2xx and discards
// the body, but here 400/401/502 carry a JSON `{ error }` the caller must read to
// classify. NEVER throws; NEVER logs the key or the signature.

import type { Signer } from "@mysten/sui/cryptography";

// 30s, not 10s: the live data gateway resolves/writes Walrus-backed pointers (and intake
// validates jobs against them), so POST /jobs and POST /agent-endpoints routinely take >10s on a
// remote deployment. deliverJob (90s) and registerSealedResult (180s) override this explicitly.
const DEFAULT_TIMEOUT_MS = 30_000;

export interface QuadraSignedRequestInput {
  /** The agent signer (an Ed25519 keypair from normalizeWalrusSigner). */
  readonly signer: Signer;
  /** Service base URL, e.g. config.intakeUrl. No trailing slash required. */
  readonly baseUrl: string;
  /** Request path, e.g. "/jobs". */
  readonly path: string;
  /** The JSON-serializable request body. Serialized exactly once, here. */
  readonly payload: unknown;
  /** Abort timeout in ms (default 10s). */
  readonly timeoutMs?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number;
}

// A transport-level outcome: ok:true means an HTTP response came back with a (parsed)
// body — NOT that the status was 2xx. `status` is carried so the caller classifies.
// `json` is the parsed JSON body, or the raw text if not JSON, or undefined if empty.
export type QuadraResponse =
  | { ok: true; status: number; json: unknown }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true };

function networkError(err: unknown, fallback: string): QuadraResponse {
  return {
    ok: false,
    kind: "network_error",
    errorName: err instanceof Error ? err.constructor.name : "Error",
    message: err instanceof Error ? err.message : fallback,
    retryable: true,
  };
}

// Pull a Quadra service's `{ error }` message (intake + gateway carry it on 400/401/
// 5xx), falling back to the raw text body, or "". Shared by the typed service clients.
export function errorMessage(json: unknown): string {
  if (json !== null && typeof json === "object") {
    const e = (json as { error?: unknown }).error;
    if (typeof e === "string") return e;
  }
  return typeof json === "string" ? json : "";
}

// A stale-timestamp 401 is the one retryable auth failure (the clock skewed; re-signing
// with a fresh ts may succeed). "bad signature" / "agent not registered" are terminal.
export function isStale(message: string): boolean {
  return /stale/i.test(message);
}

// Read a response body without ever throwing: parse JSON when present, fall back to the
// raw text for a non-JSON body, undefined for an empty body.
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Sign and POST a JSON payload to a Quadra service. Returns the HTTP status + parsed
 * body for ANY status (so the caller can classify 200/400/401/502), or a typed
 * network_error if the request could not complete (transport failure, abort, or — in
 * the vanishingly unlikely case — a signing failure). NEVER throws.
 */
export async function sendQuadraSignedRequest(
  input: QuadraSignedRequestInput,
): Promise<QuadraResponse> {
  // 1. Serialize ONCE: this exact string is both signed and sent.
  const body = JSON.stringify(input.payload);
  const ts = (input.now ?? Date.now)();

  // 2. Sign `${ts}.${body}` as a Sui personal message (signature is base64).
  let signature: string;
  try {
    ({ signature } = await input.signer.signPersonalMessage(
      new TextEncoder().encode(`${ts}.${body}`),
    ));
  } catch (err) {
    return networkError(err, "failed to sign request");
  }

  // 3. POST the exact body with the two auth headers, bounded by a timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${input.baseUrl}${input.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-quadra-ts": String(ts),
        "x-quadra-sig": signature,
      },
      body,
      signal: controller.signal,
    });
    return { ok: true, status: res.status, json: await readBody(res) };
  } catch (err) {
    return networkError(err, "request failed");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Unsigned GET returning the same transport-level union — for open endpoints like
 * /health and /status. NEVER throws.
 */
export async function getQuadraJson(
  baseUrl: string,
  path: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<QuadraResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, { method: "GET", signal: controller.signal });
    return { ok: true, status: res.status, json: await readBody(res) };
  } catch (err) {
    return networkError(err, "request failed");
  } finally {
    clearTimeout(timer);
  }
}
