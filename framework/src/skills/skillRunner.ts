// skillRunner.ts — deterministic skill dispatcher: the single execution boundary
// that validates input/output and runs developer code. Never throws for the three
// expected failures (bad input, run() threw, bad output) — each becomes a typed
// SkillResult. Nested ctx.callSkill failures throw SkillCallError into the outer
// run()'s try/catch, folding into the outer skill's run_failed.

import type { Skill, SkillContext } from "./defineSkill.js";
import { makeHttp, type LoopHttp } from "../http.js";
import {
  inputInvalid,
  outputInvalid,
  runFailed,
  skillUndeclared,
  formatZodIssues,
  type SkillError,
} from "../errors.js";

/**
 * A skill of any I/O type, for heterogeneous collections only (manifest array,
 * allow-list set). `any` is deliberate: SkillRun is invariant in its input, so
 * Skill<unknown, unknown> would reject concrete skills; collected skills are only
 * identity-compared or read by .name, never run with a typed input.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySkill = Skill<any, any>;

/** The ctx.callSkill allow-list: declared skills by object IDENTITY. */
export type AllowedSkills = ReadonlySet<AnySkill>;

/** A skill run's typed result: ok+value, or a typed error (never a throw). */
export type SkillResult<O> =
  | { readonly ok: true; readonly value: O }
  | { readonly ok: false; readonly error: SkillError };

/** An Error carrying a SkillError, thrown by ctx.callSkill on a nested failure so it
 *  folds into the calling skill's run_failed (catchable via `e instanceof SkillCallError`). */
export class SkillCallError extends Error {
  readonly skillError: SkillError;
  constructor(skillError: SkillError) {
    super(skillError.message);
    this.name = "SkillCallError";
    this.skillError = skillError;
  }
}

/**
 * Run a skill against raw input, deterministically. NEVER throws for the three
 * expected failures: bad input -> input_invalid (run() not called); run() threw ->
 * run_failed (incl. a nested SkillCallError, preserved as `cause`); bad output ->
 * output_invalid. Otherwise returns the validated output.
 */
export async function runSkill<I, O>(
  skill: Skill<I, O>,
  rawInput: unknown,
  ctx: SkillContext,
): Promise<SkillResult<O>> {
  // Validate before any developer code runs.
  const parsedInput = skill.input.safeParse(rawInput);
  if (!parsedInput.success) {
    return {
      ok: false,
      error: inputInvalid(skill.name, formatZodIssues(parsedInput.error)),
    };
  }

  // Any throw (incl. a nested SkillCallError) -> run_failed.
  let out: O;
  try {
    out = await skill.run({ input: parsedInput.data, ctx });
  } catch (caught) {
    return { ok: false, error: runFailed(skill.name, caught) };
  }

  // Validate the skill's own output contract.
  const parsedOutput = skill.output.safeParse(out);
  if (!parsedOutput.success) {
    return {
      ok: false,
      error: outputInvalid(skill.name, formatZodIssues(parsedOutput.error)),
    };
  }

  return { ok: true, value: parsedOutput.data };
}

/**
 * Build a SkillContext. callSkill runs a nested skill through runSkill with THIS SAME
 * ctx (deeper chains keep working), rejecting via SkillCallError on failure. With
 * `allowed` set, an undeclared skill is rejected before input/run (the manifest is the
 * allow-list); omitted -> permissive. `http` defaults to makeHttp(); a caller may
 * inject one shared across the turn.
 */
export interface MakeSkillContextOptions {
  readonly allowed?: AllowedSkills;
  readonly http?: LoopHttp;
}

export function makeSkillContext(opts?: MakeSkillContextOptions): SkillContext {
  const allowed = opts?.allowed;
  const http = opts?.http ?? makeHttp();
  const ctx: SkillContext = {
    async callSkill<I2, O2>(skill: Skill<I2, O2>, input: I2): Promise<O2> {
      // Allow-list check by identity (the cast only erases the I/O generics).
      if (allowed !== undefined && !allowed.has(skill as AnySkill)) {
        throw new SkillCallError(skillUndeclared(skill.name));
      }
      const result = await runSkill(skill, input, ctx);
      if (result.ok) {
        return result.value;
      }
      throw new SkillCallError(result.error);
    },
    http,
  };
  return ctx;
}
