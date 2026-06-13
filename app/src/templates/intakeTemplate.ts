// intakeTemplate.ts — the agent's rich "intake-ready" job-template contract: the shape the
// public job_templates document is parsed INTO before the agent can offer or run a job.
// Templates are the SOURCE OF TRUTH: a template itself declares the params to collect, how
// to validate them, the output/evaluator contract, and the lifetime. A template missing the
// required collection fields is NOT intake-ready and is SKIPPED (with a reason) — not a hard
// error. The data-layer `id` is load-bearing: it IS the intake engine's `template_id`. PURE
// module (no runtime, no I/O) so it is unit-testable in isolation; mirrors templates.ts's
// isValidTemplate/parseTemplates structural-validation discipline.

export type IntakeParamType = "string" | "number" | "duration";

export interface IntakeParamValidation {
  /** Default true; an explicit false makes the param optional. */
  readonly required?: boolean;
  /** number: numeric minimum; string/duration: minimum length. */
  readonly min?: number;
  /** number: numeric maximum; string/duration: maximum length. */
  readonly max?: number;
  /** string: a RegExp source the value must match (guarded ctor; partial match). */
  readonly pattern?: string;
  /** Allowed values (compared as strings). */
  readonly enum?: readonly string[];
}

export interface IntakeParam {
  /** The natural-language question the agent asks to collect this value. */
  readonly ask: string;
  readonly type: IntakeParamType;
  readonly validation?: IntakeParamValidation;
}

export interface IntakeTemplate {
  /** REAL data-layer template id; equals the intake engine's `template_id`. */
  readonly id: string;
  readonly category: string;
  readonly evaluator_id: string;
  readonly description: string;
  /** Required parameters keyed by name; NON-empty for an intake-ready template. */
  readonly params: Record<string, IntakeParam>;
  /** The result schema the agent must produce; NON-empty. */
  readonly output: Record<string, "number" | "string">;
  /** The job's validity window, e.g. "5m". */
  readonly lifetime: string;
}

export interface SkippedTemplate {
  readonly id: string | undefined;
  readonly reason: string;
}

export type ParseIntakeTemplatesResult =
  | { ok: true; templates: IntakeTemplate[]; skipped: SkippedTemplate[] }
  | { ok: false; kind: "invalid_templates_doc"; errorName: string; message: string; retryable: false };

const PARAM_TYPES: ReadonlySet<string> = new Set(["string", "number", "duration"]);
const OUTPUT_TYPES: ReadonlySet<string> = new Set(["number", "string"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// The declarative-rule keys a param may carry FLAT (e.g. `required: true`) or nested under
// `validation`. Flat and nested are merged (nested wins on conflict) so both the canonical
// platform shape `{ key, ask, type, required }` and a nested `{ ask, type, validation }` work.
const VALIDATION_KEYS = ["required", "min", "max", "pattern", "enum"] as const;

// Build a typed validation block from the merged flat+nested rule fields. A wrong-typed rule
// is a hard problem (the template author's bug), surfaced as a reason. Empty -> undefined.
function coerceValidation(
  raw: Record<string, unknown>,
): { ok: true; validation?: IntakeParamValidation } | { ok: false; reason: string } {
  const v: { required?: boolean; min?: number; max?: number; pattern?: string; enum?: string[] } = {};
  if (raw.required !== undefined) {
    if (typeof raw.required !== "boolean") return { ok: false, reason: "'required' must be a boolean" };
    v.required = raw.required;
  }
  if (raw.min !== undefined) {
    if (typeof raw.min !== "number") return { ok: false, reason: "'min' must be a number" };
    v.min = raw.min;
  }
  if (raw.max !== undefined) {
    if (typeof raw.max !== "number") return { ok: false, reason: "'max' must be a number" };
    v.max = raw.max;
  }
  if (raw.pattern !== undefined) {
    if (typeof raw.pattern !== "string") return { ok: false, reason: "'pattern' must be a string" };
    v.pattern = raw.pattern;
  }
  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || !raw.enum.every((e) => typeof e === "string")) {
      return { ok: false, reason: "'enum' must be a string array" };
    }
    v.enum = raw.enum as string[];
  }
  return Object.keys(v).length > 0 ? { ok: true, validation: v } : { ok: true };
}

// Coerce one raw param (flat or nested) into a typed IntakeParam, or a reason on failure.
function coerceParam(entry: unknown): { ok: true; param: IntakeParam } | { ok: false; reason: string } {
  if (!isPlainObject(entry)) return { ok: false, reason: "param is not an object" };
  if (!isNonEmptyString(entry.ask)) return { ok: false, reason: "param missing non-empty 'ask'" };
  if (!PARAM_TYPES.has(entry.type as string)) return { ok: false, reason: "param has an invalid 'type'" };
  const merged: Record<string, unknown> = isPlainObject(entry.validation) ? { ...entry.validation } : {};
  for (const k of VALIDATION_KEYS) {
    if (entry[k] !== undefined && merged[k] === undefined) merged[k] = entry[k];
  }
  const validation = coerceValidation(merged);
  if (!validation.ok) return validation;
  return {
    ok: true,
    param: {
      ask: entry.ask,
      type: entry.type as IntakeParamType,
      ...(validation.validation !== undefined ? { validation: validation.validation } : {}),
    },
  };
}

// Normalize `params` from EITHER the canonical array `[{ key, ask, type, required }]` OR a
// Record `{ name: { ask, type, validation? } }` into the internal name->IntakeParam map.
function normalizeParams(
  raw: unknown,
): { ok: true; params: Record<string, IntakeParam> } | { ok: false; reason: string } {
  const out: Record<string, IntakeParam> = {};
  if (Array.isArray(raw)) {
    for (const el of raw) {
      if (!isPlainObject(el) || !isNonEmptyString(el.key)) {
        return { ok: false, reason: "a params entry is missing a non-empty 'key'" };
      }
      const coerced = coerceParam(el);
      if (!coerced.ok) return coerced;
      out[el.key] = coerced.param;
    }
  } else if (isPlainObject(raw)) {
    for (const [name, entry] of Object.entries(raw)) {
      const coerced = coerceParam(entry);
      if (!coerced.ok) return coerced;
      out[name] = coerced.param;
    }
  } else {
    return { ok: false, reason: "params must be an array or an object" };
  }
  if (Object.keys(out).length === 0) {
    return { ok: false, reason: "params is empty (no collection fields)" };
  }
  return { ok: true, params: out };
}

/**
 * Validate AND normalize a candidate into a typed IntakeTemplate, or a reason on failure.
 * Accepts the canonical array `params` (with flat `required`/rules) and the nested-Record
 * form. The data-layer `id` is required. PURE.
 */
function coerceIntakeTemplate(
  value: unknown,
): { ok: true; template: IntakeTemplate } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: "not a JSON object" };
  if (!isNonEmptyString(value.id)) return { ok: false, reason: "missing non-empty id" };
  if (!isNonEmptyString(value.evaluator_id)) return { ok: false, reason: "missing non-empty evaluator_id" };
  if (!isNonEmptyString(value.category)) return { ok: false, reason: "missing non-empty category" };
  if (!isNonEmptyString(value.description)) return { ok: false, reason: "missing non-empty description" };
  if (!isNonEmptyString(value.lifetime)) return { ok: false, reason: "missing non-empty lifetime" };

  const params = normalizeParams(value.params);
  if (!params.ok) return params;

  if (!isPlainObject(value.output)) return { ok: false, reason: "missing output map" };
  const outputTypes = Object.values(value.output);
  if (outputTypes.length === 0) return { ok: false, reason: "output map is empty" };
  if (!outputTypes.every((t) => OUTPUT_TYPES.has(t as string))) {
    return { ok: false, reason: "output has a non-number|string type" };
  }

  return {
    ok: true,
    template: {
      id: value.id,
      category: value.category,
      evaluator_id: value.evaluator_id,
      description: value.description,
      params: params.params,
      output: value.output as Record<string, "number" | "string">,
      lifetime: value.lifetime,
    },
  };
}

// Pull the id from a candidate (for a skip record) without trusting its shape.
function candidateId(value: unknown): string | undefined {
  if (isPlainObject(value) && typeof value.id === "string") return value.id;
  return undefined;
}

/**
 * Parse the raw job_templates payload into intake-ready templates + a list of skipped
 * (non-intake-ready) ones. Accepts either the gateway array (`JobTemplate[]`) or the full
 * doc (`{ templates: Record<id, JobTemplate>, updated_at }`). A candidate that is not a
 * well-formed IntakeTemplate is SKIPPED with a reason — NOT a hard failure — because under
 * the current minimal data-layer schema every template lacks collection fields and that is
 * the honest "not intake-ready" state, not an error. Only a non-array, non-doc top level is
 * `invalid_templates_doc`. NEVER throws. All-skipped -> ok:true with an empty `templates`.
 */
export function parseIntakeTemplates(raw: unknown): ParseIntakeTemplatesResult {
  let candidates: unknown[];
  if (Array.isArray(raw)) {
    candidates = raw;
  } else if (isPlainObject(raw) && isPlainObject(raw.templates)) {
    candidates = Object.values(raw.templates);
  } else {
    return {
      ok: false,
      kind: "invalid_templates_doc",
      errorName: "InvalidTemplatesDoc",
      message: "job templates payload was neither a JSON array nor a { templates } document",
      retryable: false,
    };
  }

  const templates: IntakeTemplate[] = [];
  const skipped: SkippedTemplate[] = [];
  for (const candidate of candidates) {
    const coerced = coerceIntakeTemplate(candidate);
    if (coerced.ok) {
      templates.push(coerced.template);
    } else {
      skipped.push({ id: candidateId(candidate), reason: coerced.reason });
    }
  }
  return { ok: true, templates, skipped };
}

export type ValidateValueResult = { ok: true } | { ok: false; reason: string };

/**
 * Validate a collected (non-empty) string value against a param's declared type + rules.
 * Used by the optional lifecycle gate and the proactive-collection flow. PURE; NEVER throws
 * (a malformed `pattern` is treated as no constraint rather than a thrown RegExp).
 */
export function validateParamValue(param: IntakeParam, value: string): ValidateValueResult {
  const v = param.validation ?? {};
  if (param.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, reason: `"${value}" is not a number` };
    if (v.min !== undefined && n < v.min) return { ok: false, reason: `must be >= ${v.min}` };
    if (v.max !== undefined && n > v.max) return { ok: false, reason: `must be <= ${v.max}` };
  } else {
    if (v.min !== undefined && value.length < v.min) {
      return { ok: false, reason: `must be at least ${v.min} characters` };
    }
    if (v.max !== undefined && value.length > v.max) {
      return { ok: false, reason: `must be at most ${v.max} characters` };
    }
    if (v.pattern !== undefined) {
      try {
        if (!new RegExp(v.pattern).test(value)) {
          return { ok: false, reason: "does not match the required format" };
        }
      } catch {
        // A malformed pattern in the template is the author's bug, not the user's value;
        // do not reject the value over it.
      }
    }
  }
  if (v.enum !== undefined && !v.enum.includes(value)) {
    return { ok: false, reason: `must be one of: ${v.enum.join(", ")}` };
  }
  return { ok: true };
}

/**
 * Render a compact, READABLE description of each intake template for the SYSTEM PROMPT
 * only (never shown verbatim to the user). Includes the REAL `id`. Mirrors templates.ts's
 * renderTemplatesForPrompt.
 */
export function renderIntakeTemplatesForPrompt(templates: readonly IntakeTemplate[]): string {
  return templates
    .map((tpl, index) => {
      const questions = Object.entries(tpl.params)
        .map(([name, p]) => `      - ${name} (${p.type}): "${p.ask}"`)
        .join("\n");
      const output = Object.entries(tpl.output)
        .map(([name, type]) => `${name} (${type})`)
        .join(", ");
      return [
        `  ${index + 1}. ${tpl.description} [id: ${tpl.id}]`,
        `     Parameters to collect:`,
        questions,
        `     Produces: ${output}`,
        `     Validity window: ${tpl.lifetime}`,
      ].join("\n");
    })
    .join("\n\n");
}
