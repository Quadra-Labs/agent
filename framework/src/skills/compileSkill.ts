// compileSkill.ts — OPTIONAL compiler: a defineSkill skill -> a native ElizaOS Action
// { name, description, validate, handler } the LLM/default loop can select. Additive —
// ctx.callSkill is untouched, and wiring the Actions into the loop is the host's job.
//
// Input resolution (explicit structured input ONLY — no model call to extract args):
// options.input, else the options bag, else message.content.params; then runSkill does
// the skill's existing zod validation. No candidate -> a typed input_missing result.
// SkillResult maps totally onto ActionResult + a HandlerCallback Content (success/error).

import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  Memory,
} from "@elizaos/core";

import { assertValidSkillName, type Skill, type SkillContext } from "./defineSkill.js";
import {
  runSkill,
  makeSkillContext,
  type SkillResult,
  type AnySkill,
} from "./skillRunner.js";
import type { SkillError } from "../errors.js";

/** Compile options. `ctx` lets the host supply the SkillContext (e.g. a registry-bound
 *  one to allow-list nested ctx.callSkill); absent -> a fresh permissive context. */
export interface CompileSkillOptions {
  readonly ctx?: SkillContext;
}

/** The data shape the compiled action emits on a SUCCESSFUL run. */
export interface CompiledSkillSuccessData {
  readonly type: "skill.success";
  readonly skill: string;
  readonly output: unknown;
}

/** The data shape the compiled action emits on ANY failure (incl. input_missing). */
export interface CompiledSkillErrorData {
  readonly type: "skill.error";
  readonly skill: string;
  readonly kind: SkillError["kind"] | "input_missing";
  readonly message: string;
}

// HandlerOptions keys that are runtime plumbing, stripped from the options-bag fallback.
const RESERVED_OPTION_KEYS: ReadonlySet<string> = new Set([
  "input",
  "actionContext",
  "actionPlan",
]);

// ElizaOS action names are SCREAMING_SNAKE; skill names are lower_snake. Uppercase maps
// between them (original preserved on the action). assertValidSkillName backstops a
// hand-built skill that bypassed defineSkill so an unsafe name can't become a bad Action name.
export function actionNameForSkill(skillName: string): string {
  assertValidSkillName(skillName);
  return skillName.toUpperCase();
}

// Resolve the candidate raw input per the locked precedence; { found:false } when none
// (so the handler emits a typed input_missing instead of feeding undefined to zod).
type ResolvedInput =
  | { readonly found: true; readonly raw: unknown }
  | { readonly found: false };

function resolveSkillInput(
  message: Memory,
  options?: HandlerOptions,
): ResolvedInput {
  // 1. options.input — an explicit structured input object wins outright.
  if (options !== undefined && options.input !== undefined) {
    return { found: true, raw: options.input };
  }
  // 2. the options bag itself, minus reserved runtime keys. Only counts as input if at
  //    least one non-reserved key is present (an empty/plumbing-only bag is NOT input).
  if (options !== undefined) {
    const own = Object.keys(options).filter((k) => !RESERVED_OPTION_KEYS.has(k));
    if (own.length > 0) {
      const raw: Record<string, unknown> = {};
      for (const k of own) raw[k] = options[k];
      return { found: true, raw };
    }
  }
  // 3. message.content.params — an explicit structured params object on the message.
  const params = message.content?.params;
  if (params !== undefined) {
    return { found: true, raw: params };
  }
  return { found: false };
}

// Build the Content emitted via the HandlerCallback for a result (success or error).
function contentFor(text: string, data: Record<string, unknown>): Content {
  return { text, data };
}

// Map a SkillResult onto { content, actionResult }. Total: success -> success:true with
// the validated output; every SkillError -> success:false with the error message + kind.
function mapResult(
  skillName: string,
  result: SkillResult<unknown>,
): { content: Content; actionResult: ActionResult } {
  if (result.ok) {
    const data: CompiledSkillSuccessData = {
      type: "skill.success",
      skill: skillName,
      output: result.value,
    };
    const text = `skill "${skillName}" succeeded.`;
    return {
      content: contentFor(text, { ...data }),
      actionResult: { success: true, text, data: { ...data } },
    };
  }
  const data: CompiledSkillErrorData = {
    type: "skill.error",
    skill: skillName,
    kind: result.error.kind,
    message: result.error.message,
  };
  return {
    content: contentFor(result.error.message, { ...data }),
    actionResult: {
      success: false,
      text: result.error.message,
      error: result.error.message,
      data: { ...data },
    },
  };
}

// The typed input_missing result (no structured input at all — distinct from zod's
// input_invalid, which means an input was present but failed the schema).
function inputMissing(skillName: string): { content: Content; actionResult: ActionResult } {
  const message =
    `skill "${skillName}" requires a structured input object via options.input, the ` +
    `options bag, or message.content.params; none was provided`;
  const data: CompiledSkillErrorData = {
    type: "skill.error",
    skill: skillName,
    kind: "input_missing",
    message,
  };
  return {
    content: contentFor(message, { ...data }),
    actionResult: { success: false, text: message, error: message, data: { ...data } },
  };
}

/**
 * Compile ONE skill into an ElizaOS Action (pure). name = SCREAMING_SNAKE; validate
 * returns whether the resolved structured input zod-parses (none -> false); handler runs
 * the skill via runSkill, emits a Content via the callback, and returns the mapped
 * ActionResult (never throws for expected failures). Additive — ctx.callSkill unchanged.
 */
export function compileSkillToAction(
  skill: AnySkill,
  opts?: CompileSkillOptions,
): Action {
  const ctx: SkillContext = opts?.ctx ?? makeSkillContext();
  const skillName = skill.name;

  const action: Action = {
    name: actionNameForSkill(skillName),
    // Extra field for round-trip (Action permits [key]: unknown).
    skillName,
    description: skill.description,
    validate: async (_runtime, message, _state): Promise<boolean> => {
      const resolved = resolveSkillInput(message);
      if (!resolved.found) return false;
      return skill.input.safeParse(resolved.raw).success;
    },
    handler: async (
      _runtime,
      message,
      _state,
      options,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const resolved = resolveSkillInput(message, options);
      const { content, actionResult } = resolved.found
        ? mapResult(skillName, await runSkill(skill as Skill<unknown, unknown>, resolved.raw, ctx))
        : inputMissing(skillName);
      if (callback !== undefined) {
        await callback(content);
      }
      return actionResult;
    },
  };

  return action;
}

/** Compile a list of skills into Actions (thin order-preserving map, same options each). */
export function compileSkills(
  skills: readonly AnySkill[],
  opts?: CompileSkillOptions,
): Action[] {
  return skills.map((skill) => compileSkillToAction(skill, opts));
}
