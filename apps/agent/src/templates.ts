// templates.ts — A4 Task 1: read/write job templates ON Walrus via the SDK service.
//
// The framework's ONLY domain knowledge is a template set stored as a JSON blob on
// Walrus (not hardcoded at runtime). This module seeds that blob and reads it back
// THROUGH the live `walrus` service (runtime.getService("walrus").store/read) —
// the SDK path, NOT the demo's HTTP path. It is a plain framework module, NOT a
// service: it consumes the existing long-lived WalrusService.
//
// Shape note (LIFTED from demo/src/templates.ts, the proven precedent): `job_template`
// is the canonical contract shape the team agreed on ({ output, lifetime }). The
// agent-facing fields (category_id, title, params) are what the assistant reasons
// over and asks the user about. The raw template must NEVER be shown verbatim to the
// user — renderTemplatesForPrompt produces a readable description for the SYSTEM
// PROMPT only (A4 Task 2 injects it).
//
// FAILURE STYLE (mirrors plugin-walrus / plugin-memwal): seed/load return a typed
// ok/kind discriminated union, NEVER a blind throw. A Walrus store/read failure maps
// the underlying WalrusStoreResult/WalrusReadResult kind straight through; a blob
// that read back but was malformed (not a JSON array of templates) is the
// module-specific `invalid_templates` kind. Callers branch on `ok`/`kind`.

import type { IAgentRuntime } from "@elizaos/core";

import type {
  WalrusReadResult,
  WalrusStoreResult,
} from "../../../plugins/plugin-walrus/src/types.js";

// --- Template contract types (LIFTED from demo/src/templates.ts) -------------

/** A single conversationally-collected parameter. */
export interface JobParam {
  /** The natural-language question the agent asks to collect this value. */
  readonly ask: string;
  /** The value's shape, used only to guide the agent (never shown raw). */
  readonly type: "string" | "number" | "duration";
}

/** A job the agent can recognize, confirm, and collect parameters for. */
export interface JobTemplate {
  /** Stable machine id, e.g. "btc-price-guess". Internal; not shown to the user. */
  readonly category_id: string;
  /** Human label used when confirming the match, e.g. "Cryptocurrency price...". */
  readonly title: string;
  /** Required parameters keyed by name; each carries its natural question. */
  readonly params: Record<string, JobParam>;
  /** Canonical team-contract job shape. Internal; never shown to the user. */
  readonly job_template: {
    readonly output: Record<string, "number" | "string">;
    readonly lifetime: string;
  };
}

// Two fake-but-canonical default templates (LIFTED from demo/src/templates.ts). Used
// when seedTemplates is called without an explicit set. Kept small and readable.
export const DEFAULT_TEMPLATES: readonly JobTemplate[] = [
  {
    category_id: "btc-price-guess",
    title: "Cryptocurrency price-range prediction",
    params: {
      asset: { ask: "Which cryptocurrency should I predict?", type: "string" },
      horizon: {
        ask: "Over what time window should I predict the range?",
        type: "duration",
      },
    },
    job_template: {
      output: { minPrice: "number", maxPrice: "number" },
      lifetime: "5m",
    },
  },
  {
    category_id: "polymarket-resolution",
    title: "Polymarket market resolution",
    params: {
      market: { ask: "Which Polymarket market or question should I resolve?", type: "string" },
      resolveBy: { ask: "By when should it resolve?", type: "duration" },
    },
    job_template: {
      output: { outcome: "string" },
      lifetime: "1h",
    },
  },
];

// --- Typed results (mirror the walrus/memwal ok/kind unions) -----------------
// A Walrus failure maps the underlying store/read kind through unchanged so the
// caller sees the same vocabulary it would from the service directly.
// `invalid_templates` is the module-specific kind for a blob that read back ok but
// did not parse into a JSON array of templates.

export type SeedTemplatesResult =
  | { ok: true; blobId: string }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false };

export type LoadTemplatesResult =
  | { ok: true; templates: JobTemplate[] }
  | { ok: false; kind: "blob_unavailable"; blobId: string; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "invalid_templates"; blobId: string; errorName: string; message: string; retryable: false };

// --- The Walrus surface this module drives (structural mirror) ---------------
// Resolved from the booted runtime via getService("walrus"); narrowed to exactly
// the two methods we call. Mirrors closeSession.ts / recallCheckpoint.ts —
// apps/agent depends on the runtime CONTRACT, not on plugin-walrus's internal
// class. The locked result TYPES (WalrusStoreResult / WalrusReadResult) are
// imported from the plugin's types.ts; only the service CLASS is resolved
// structurally.
type WalrusLike = {
  store(bytes: Uint8Array): Promise<WalrusStoreResult>;
  read(blobId: string): Promise<WalrusReadResult>;
};

function resolveWalrus(runtime: IAgentRuntime): WalrusLike | undefined {
  const resolved = runtime.getService("walrus");
  if (resolved === undefined || resolved === null) return undefined;
  return resolved as unknown as WalrusLike;
}

// The "walrus service not registered" config_error shape, factored out so seed and
// load return an identical typed outcome (never a throw) when the service is absent.
function walrusUnavailable(): {
  ok: false;
  kind: "config_error";
  errorName: string;
  message: string;
  retryable: false;
} {
  return {
    ok: false,
    kind: "config_error",
    errorName: "WalrusServiceUnavailable",
    message: "walrus service is not registered",
    retryable: false,
  };
}

// --- Seed / load round-trip --------------------------------------------------

/**
 * JSON-encode the template array and store it on Walrus through the SDK service.
 * Returns a typed result: ok:true + blobId on success, or the underlying Walrus
 * store failure (network_error / config_error) mapped straight through. NEVER
 * throws for a Walrus failure or a missing service. `templates` defaults to
 * DEFAULT_TEMPLATES.
 */
export async function seedTemplates(
  runtime: IAgentRuntime,
  templates: readonly JobTemplate[] = DEFAULT_TEMPLATES,
): Promise<SeedTemplatesResult> {
  const walrus = resolveWalrus(runtime);
  if (walrus === undefined) {
    return walrusUnavailable();
  }

  const bytes = new TextEncoder().encode(JSON.stringify(templates));
  const result = await walrus.store(bytes);
  if (result.ok) {
    return { ok: true, blobId: result.blobId };
  }
  // ok:false -> map the typed Walrus store failure through unchanged.
  return {
    ok: false,
    kind: result.kind,
    errorName: result.errorName,
    message: result.message,
    retryable: result.retryable,
  } as SeedTemplatesResult;
}

/**
 * Read the template array back from Walrus through the SDK service and parse it.
 * Returns a typed result: ok:true + templates on success; the underlying Walrus
 * read failure (blob_unavailable / network_error / config_error) mapped straight
 * through; or invalid_templates when the blob read back but was not valid JSON / not
 * a JSON array. NEVER throws for any of these.
 */
export async function loadTemplates(
  runtime: IAgentRuntime,
  blobId: string,
): Promise<LoadTemplatesResult> {
  const walrus = resolveWalrus(runtime);
  if (walrus === undefined) {
    return walrusUnavailable();
  }

  const result = await walrus.read(blobId);
  if (!result.ok) {
    // Map the typed Walrus read failure through unchanged.
    return {
      ok: false,
      kind: result.kind,
      ...(result.kind === "blob_unavailable" ? { blobId: result.blobId } : {}),
      errorName: result.errorName,
      message: result.message,
      retryable: result.retryable,
    } as LoadTemplatesResult;
  }

  // ok:true -> the blob is durable bytes; parse + validate into templates. A parse
  // failure or non-array is a module-specific invalid_templates result (NOT a throw).
  return parseTemplates(blobId, result.bytes);
}

// The param value-types a template may declare. Kept in sync with JobParam.type.
const PARAM_TYPES: ReadonlySet<string> = new Set(["string", "number", "duration"]);
// The output value-types the canonical job_template.output may declare.
const OUTPUT_TYPES: ReadonlySet<string> = new Set(["number", "string"]);

// A plain (non-null, non-array) object. The structural checks below all start here
// so a JSON `null`, array, or primitive in a template slot is rejected, not indexed.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A single params entry: { ask: string, type: "string"|"number"|"duration" }.
function isValidParam(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return typeof value.ask === "string" && PARAM_TYPES.has(value.type as string);
}

/**
 * Structural validator for ONE template element. The framework consumes
 * Walrus-hosted (untrusted) template blobs, so "is an array" is NOT enough — each
 * element must actually be a JobTemplate or render/match would later throw a raw
 * TypeError PAST the typed-error boundary. Checks exactly the locked shape:
 *   category_id: string, title: string,
 *   params: object of { ask: string, type: "string"|"number"|"duration" } (non-empty),
 *   job_template.output: object of "number"|"string" (non-empty),
 *   job_template.lifetime: string.
 * Pure. Exported so the proof can assert it directly.
 */
export function isValidTemplate(value: unknown): value is JobTemplate {
  if (!isPlainObject(value)) return false;
  if (typeof value.category_id !== "string" || typeof value.title !== "string") return false;

  // params: a non-empty object whose every entry is a valid JobParam.
  if (!isPlainObject(value.params)) return false;
  const paramEntries = Object.values(value.params);
  if (paramEntries.length === 0 || !paramEntries.every(isValidParam)) return false;

  // job_template: { output: non-empty object of number|string, lifetime: string }.
  const jt = value.job_template;
  if (!isPlainObject(jt)) return false;
  if (typeof jt.lifetime !== "string") return false;
  if (!isPlainObject(jt.output)) return false;
  const outputTypes = Object.values(jt.output);
  if (outputTypes.length === 0) return false;
  return outputTypes.every((t) => OUTPUT_TYPES.has(t as string));
}

/**
 * Decode + parse blob bytes into a JobTemplate[]. Pure (no runtime, no I/O) so it
 * is unit-testable in isolation. A non-JSON payload, a non-array, OR an array whose
 * ANY element is not a well-formed JobTemplate all yield a typed invalid_templates
 * result (NOT a throw, and NOT a deceptive ok:true) — the framework consumes
 * untrusted Walrus blobs, so a structurally-wrong-but-array payload must be caught
 * HERE, at the typed boundary, not later in render/match. Exported for the proof.
 */
export function parseTemplates(blobId: string, bytes: Uint8Array): LoadTemplatesResult {
  const invalid = (message: string): LoadTemplatesResult => ({
    ok: false,
    kind: "invalid_templates",
    blobId,
    errorName: "InvalidTemplatesError",
    message,
    retryable: false,
  });

  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return invalid(`Templates blob ${blobId} was not valid JSON: ${String(cause)}`);
  }
  if (!Array.isArray(parsed)) {
    return invalid(`Templates blob ${blobId} did not contain a JSON array.`);
  }
  // Per-element shape check: a single malformed element invalidates the whole blob.
  // Naming the offending index keeps the failure diagnosable without leaking content.
  const badIndex = parsed.findIndex((element) => !isValidTemplate(element));
  if (badIndex !== -1) {
    return invalid(
      `Templates blob ${blobId} element ${badIndex} is not a well-formed job template ` +
        "(needs category_id/title strings, a non-empty params map of {ask,type}, and " +
        "job_template {output map of number|string, lifetime string}).",
    );
  }
  return { ok: true, templates: parsed as JobTemplate[] };
}

// --- Render for the system prompt --------------------------------------------

/**
 * Render a compact, READABLE description of each template for injection into the
 * system prompt. This is what the agent reasons over to match and collect
 * parameters. It must NEVER be shown verbatim to the user. LIFTED from
 * demo/src/templates.ts renderTemplatesForPrompt.
 */
export function renderTemplatesForPrompt(templates: readonly JobTemplate[]): string {
  return templates
    .map((tpl, index) => {
      const questions = Object.entries(tpl.params)
        .map(([name, p]) => `      - ${name} (${p.type}): "${p.ask}"`)
        .join("\n");
      const output = Object.entries(tpl.job_template.output)
        .map(([name, type]) => `${name} (${type})`)
        .join(", ");
      return [
        `  ${index + 1}. ${tpl.title} [id: ${tpl.category_id}]`,
        `     Parameters to collect:`,
        questions,
        `     Produces: ${output}`,
        `     Validity window: ${tpl.job_template.lifetime}`,
      ].join("\n");
    })
    .join("\n\n");
}
