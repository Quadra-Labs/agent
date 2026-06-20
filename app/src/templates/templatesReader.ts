// templatesReader.ts — read the public job_templates document from the data gateway
// (GET /templates, OPEN) and compute a content hash used as the freshness key. The wire
// returns only the array (no updated_at), so the hash is the authoritative staleness signal
// today; the watch SSE feed's PointerChange { blobId, version, updatedAtMs } and a future
// doc-returning endpoint are the upgrade path (sourceUpdatedAt stays undefined until then).
// NEVER throws — reuses getQuadraJson (open GET) and returns a typed ok/kind union.

import { createHash } from "node:crypto";

import { getQuadraJson } from "../quadra/quadraSignedRequest.js";

export interface FetchedTemplates {
  /** The parsed JSON the gateway returned (array today; possibly a doc in future). */
  readonly raw: unknown;
  /** sha256 over the canonicalized raw payload — the freshness key. */
  readonly sourceHash: string;
  /** Only set if the payload is a doc carrying a numeric updated_at (future signal). */
  readonly sourceUpdatedAt?: number;
}

export type FetchTemplatesResult =
  | { ok: true; fetched: FetchedTemplates }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "unexpected_status"; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "invalid_body"; errorName: string; message: string; retryable: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Recursively key-sort objects so a re-ordered-but-equivalent object hashes the SAME.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

// Extract the template list from either the array or the { templates } doc form; undefined
// when the payload is neither (then the whole thing is hashed generically).
function templateList(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (isPlainObject(raw) && isPlainObject(raw.templates)) return Object.values(raw.templates);
  return undefined;
}

// Sort key for a canonicalized template: by id (primary), then full JSON (tie-break).
function sortKey(el: unknown): string {
  const id = isPlainObject(el) && typeof el.id === "string" ? el.id : "";
  return `${id} ${JSON.stringify(el)}`;
}

/**
 * sha256 hex over a CANONICAL, order-insensitive representation: the template list is
 * sorted by id (then canonical JSON) and every object's keys are sorted. So neither a
 * reordered template list nor reordered object keys cause a false cache invalidation, but
 * any genuine content change does. PURE.
 */
function computeSourceHash(raw: unknown): string {
  const list = templateList(raw);
  const normalized =
    list === undefined
      ? canonicalize(raw)
      : list
          .map(canonicalize)
          .sort((a, b) => {
            const ka = sortKey(a);
            const kb = sortKey(b);
            return ka < kb ? -1 : ka > kb ? 1 : 0;
          });
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Fetch GET /templates and produce a freshness-keyed snapshot. `network_error` passes
 * through from the transport; a non-200 is `unexpected_status`; a 200 whose body is not a
 * JSON array or object is `invalid_body`. NEVER throws.
 *
 * The timeout is deliberately generous (30s, vs the 10s shared default): /templates reads the
 * job-templates document from the data layer and can be slow on a remote gateway, and this is a
 * boot-time, latency-tolerant fetch — better to wait than to spuriously report `network_error`
 * and boot with an empty menu. A genuinely-down gateway still fails fast (connection refused).
 */
export async function fetchJobTemplates(
  baseUrl: string,
  timeoutMs = 30_000,
): Promise<FetchTemplatesResult> {
  const res = await getQuadraJson(baseUrl, "/templates", timeoutMs);
  if (!res.ok) return res; // network_error

  if (res.status !== 200) {
    return {
      ok: false,
      kind: "unexpected_status",
      errorName: "UnexpectedStatus",
      message: `gateway /templates responded ${res.status}`,
      retryable: false,
    };
  }

  const raw = res.json;
  const isArray = Array.isArray(raw);
  const isObject = raw !== null && typeof raw === "object";
  if (!isArray && !isObject) {
    return {
      ok: false,
      kind: "invalid_body",
      errorName: "InvalidBody",
      message: "gateway /templates body was not a JSON array or object",
      retryable: false,
    };
  }

  const sourceUpdatedAt =
    !isArray && isObject && typeof (raw as { updated_at?: unknown }).updated_at === "number"
      ? (raw as { updated_at: number }).updated_at
      : undefined;

  return {
    ok: true,
    fetched: {
      raw,
      sourceHash: computeSourceHash(raw),
      ...(sourceUpdatedAt !== undefined ? { sourceUpdatedAt } : {}),
    },
  };
}
