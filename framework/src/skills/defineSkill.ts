// defineSkill.ts — typed skill primitive: declare a named, schema-bounded capability.
// Pure construction only: no validation, no execution (skillRunner owns that boundary).
// The input/output zod schemas drive run()'s inferred argument/return types.

import type { ZodType } from "zod";

import type { LoopHttp } from "../http.js";

/**
 * Context a skill's run() receives: callSkill (compose other skills) and http
 * (the outbound-network choke-point). LoopContext extends this, so skills and
 * onTurn share the same callSkill/http semantics.
 */
export interface SkillContext {
  /** Run another skill with the same validation; resolves to its validated output
   *  or rejects with its SkillError-shaped failure. */
  callSkill<I2, O2>(skill: Skill<I2, O2>, input: I2): Promise<O2>;
  /** Bounded outbound HTTP. Throws on a non-2xx response (-> the dispatcher's run_failed). */
  readonly http: LoopHttp;
}

/** The single argument passed to a skill's run(): the validated input plus ctx. */
export interface SkillRunArgs<I> {
  readonly input: I;
  readonly ctx: SkillContext;
}

/**
 * A skill's implementation: validated input + ctx -> output (sync or async).
 * The output is checked against the skill's output schema by the runner, not here.
 */
export type SkillRun<I, O> = (args: SkillRunArgs<I>) => O | Promise<O>;

/** What a developer hands to defineSkill; the zod schemas drive the I/O generics. */
export interface SkillDefinition<I, O> {
  readonly name: string;
  readonly description: string;
  readonly input: ZodType<I>;
  readonly output: ZodType<O>;
  readonly run: SkillRun<I, O>;
}

/**
 * The constructed skill returned by defineSkill. A distinct named type so
 * derived fields can be added later without changing the definition shape.
 */
export interface Skill<I, O> {
  readonly name: string;
  readonly description: string;
  readonly input: ZodType<I>;
  readonly output: ZodType<O>;
  readonly run: SkillRun<I, O>;
}

// Construction-time programmer error -> plain throw; never crosses the run-time typed-result boundary.
function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`defineSkill: "${field}" must be a non-empty string`);
  }
}

// lower_snake_case; the name is the skill's identity framework-wide (registry key,
// allow-list member, compiled Action name), so enforce at construction, not compile time.
//   valid: fetch_btc   invalid: FetchBTC, fetch-btc, _fetch, fetch_, fetch__btc
const SKILL_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** Assert a valid lower_snake_case skill name; throws naming the offending value. */
export function assertValidSkillName(name: string): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(
      `defineSkill: invalid skill name "${name}": use lower_snake_case ` +
        `(e.g. "fetch_btc") — start with a letter, only [a-z0-9_], no leading/trailing ` +
        `or doubled underscores`,
    );
  }
}

/**
 * Construct a Skill from a SkillDefinition. Pure construction — no execution, no
 * zod parsing (skillRunner's job). Only construction-time sanity checks throw:
 * non-empty description, valid lower_snake_case name.
 */
export function defineSkill<I, O>(def: SkillDefinition<I, O>): Skill<I, O> {
  requireNonEmpty(def.name, "name");
  assertValidSkillName(def.name);
  requireNonEmpty(def.description, "description");
  return {
    name: def.name,
    description: def.description,
    input: def.input,
    output: def.output,
    run: def.run,
  };
}
