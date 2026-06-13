// errors.ts — the typed error taxonomy the skill dispatcher returns instead of
// throwing across the skill boundary, so a skill failure is an inspectable value.
//   input_invalid    — input failed the zod input schema; run() never executed.
//   output_invalid   — run() returned a value failing the zod output schema.
//   run_failed       — run() threw; the original value is preserved on `cause`.
//   skill_undeclared — ctx.callSkill on a skill not in the agent's manifest (the
//                      allow-list); rejected before input validation or run().

import type { ZodError } from "zod";

/**
 * A typed skill-execution failure. Returned by the dispatcher instead of throwing
 * across the skill boundary. Discriminated on `kind`; every variant carries the
 * `skillName` it concerns and a human-readable `message`.
 */
export type SkillError =
  | {
      readonly kind: "input_invalid";
      readonly skillName: string;
      readonly message: string;
      /** Flattened, readable summary of the zod validation problems on the input. */
      readonly issues: string;
    }
  | {
      readonly kind: "output_invalid";
      readonly skillName: string;
      readonly message: string;
      /** Flattened, readable summary of the zod validation problems on the output. */
      readonly issues: string;
    }
  | {
      readonly kind: "run_failed";
      readonly skillName: string;
      readonly message: string;
      /** The original thrown value, preserved unchanged for callers to inspect. */
      readonly cause: unknown;
    }
  | {
      readonly kind: "skill_undeclared";
      readonly skillName: string;
      readonly message: string;
    };

/**
 * Build an "input_invalid" error: the raw input failed the skill's zod input
 * schema before run() was ever called. Pure.
 */
export function inputInvalid(skillName: string, issues: string): SkillError {
  return {
    kind: "input_invalid",
    skillName,
    issues,
    message: `skill "${skillName}" received invalid input: ${issues}`,
  };
}

/**
 * Build an "output_invalid" error: run() returned a value that failed the skill's
 * zod output schema. Pure.
 */
export function outputInvalid(skillName: string, issues: string): SkillError {
  return {
    kind: "output_invalid",
    skillName,
    issues,
    message: `skill "${skillName}" produced invalid output: ${issues}`,
  };
}

/**
 * Build a "run_failed" error: the skill's run() threw. The raw `cause` is kept on
 * the returned object unchanged; only the `message` derives a readable form of it
 * (Error.message when it is an Error, otherwise String(cause)). Pure.
 */
export function runFailed(skillName: string, cause: unknown): SkillError {
  const readable = cause instanceof Error ? cause.message : String(cause);
  return {
    kind: "run_failed",
    skillName,
    cause,
    message: `skill "${skillName}" threw during run: ${readable}`,
  };
}

/**
 * Build a "skill_undeclared" error: ctx.callSkill was asked to run a skill the agent
 * did not declare in its M4 skills manifest. The skills array is the allow-list, so
 * this is rejected before any input validation or run(). Pure.
 */
export function skillUndeclared(skillName: string): SkillError {
  return {
    kind: "skill_undeclared",
    skillName,
    message:
      `skill "${skillName}" is not declared in this agent's skills manifest; ` +
      `ctx.callSkill may only run declared skills`,
  };
}

/**
 * Turn a ZodError into the readable `issues` string used by the input/output
 * errors above. Joins each issue as `path: message`, comma-separated. Uses the
 * zod 4 API (`error.issues`). Defensive: an issue with an empty path renders its
 * path as "(root)".
 */
export function formatZodIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join(", ");
}
