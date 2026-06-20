// defineAgent.ts — bind identity + skills + tools + models + optional onTurn into one
// AgentDefinition (one .ts file = a working agent). PURE construction: validates the
// definition shape (throws on a malformed one) and assembles the value; nothing touches
// the runtime. skills = the ctx.callSkill ALLOW-LIST (not auto-dispatch).

import type { AgentCharacter, AgentCapabilities } from "../../../app/src/character/character.js";
import type { AnySkill } from "../skills/skillRunner.js";
import type { AnyTool } from "../tools/defineTool.js";
import type { ModelSpec } from "../models.js";
import type { OnTurn } from "./loopContext.js";

/** What a developer hands to defineAgent: identity fields (mirroring AgentCharacter)
 *  plus optional skills / tools / models / onTurn. */
export interface AgentSpec {
  /** Display name AND the checkpoint index `agent` key. Non-empty. */
  readonly name: string;
  /** One or more bio lines. Non-empty array of non-empty strings. */
  readonly bio: readonly string[];
  /** OPTIONAL system-prompt override for the default chat loop. */
  readonly systemPrompt?: string;
  /** OPTIONAL job-template category ids the agent offers (the broad data-layer category, e.g.
   *  "finance" / "prediction"). Narrows the template pre-filter to matching `category`. */
  readonly templateCategoryIds?: readonly string[];
  /** OPTIONAL granular evaluator binding: the evaluation-engine evaluator_id(s) this agent's skills
   *  can actually produce — exact values OR prefixes (e.g. ["polymarket-price"] binds to that one
   *  evaluator; ["polymarket-"] binds to the whole polymarket family). When present, the template
   *  pre-filter drops any template whose `evaluator_id` is outside this set BEFORE the agent
   *  self-selects, so a "prediction" agent that only forecasts prices is never bound to a
   *  polymarket-event/-resolution template it cannot fulfil. Absent -> category-only narrowing. */
  readonly evaluators?: readonly string[];
  /** OPTIONAL: a scoreless agent is paid on delivery but never evaluated/scored and
   *  cannot join competitions. It must register on-chain as scoreless and only offer
   *  scoreless templates. Default false. */
  readonly scoreless?: boolean;
  /** OPTIONAL declared skills = the ctx.callSkill allow-list (not auto-dispatch).
   *  Under runAgent, omitted normalizes to [] = DENY-ALL. Names must be unique. */
  readonly skills?: readonly AnySkill[];
  /** OPTIONAL declared tools the MODEL decides to run via the in-process MCP server.
   *  No omitted-vs-[] distinction (both = no server). Names unique AND disjoint from
   *  skill names (one capability namespace per agent). */
  readonly tools?: readonly AnyTool[];
  /** OPTIONAL model chain (first = base, rest = fallbacks); powers every model call.
   *  Omitted/[] -> the host runtime's model. */
  readonly models?: readonly ModelSpec[];
  /** OPTIONAL custom loop over a sealed LoopContext. Absent -> the default loop (chat,
   *  or the tool loop when tools are declared). */
  readonly onTurn?: OnTurn;
}

/** The constructed definition: identity + the normalized (non-optional) skills/tools/
 *  models arrays + a once-derived `character` the rail consumes directly. */
export interface AgentDefinition {
  readonly name: string;
  readonly bio: readonly string[];
  readonly systemPrompt?: string;
  readonly templateCategoryIds?: readonly string[];
  /** The granular evaluator binding (exact ids or prefixes), normalized; absent if undeclared. */
  readonly evaluators?: readonly string[];
  /** True if this is a scoreless agent (paid on delivery, never scored, no competitions). */
  readonly scoreless: boolean;
  /** The declared skill manifest, normalized to a non-optional array. */
  readonly skills: readonly AnySkill[];
  /** The declared tool manifest, normalized to a non-optional array. */
  readonly tools: readonly AnyTool[];
  /** The model chain, normalized to a non-optional array ([] = host runtime model). */
  readonly models: readonly ModelSpec[];
  readonly onTurn?: OnTurn;
  /** The rail-facing identity, derived once from the spec's identity fields. */
  readonly character: AgentCharacter;
}

// Construction-time guard: an empty name/bio is a programmer error, so a plain throw
// at the authoring site is correct (never a runtime typed-result failure).
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Construct an AgentDefinition from an AgentSpec. PURE construction: validates the
 * definition shape (throws on a malformed one) and assembles the value; nothing boots
 * a runtime or runs onTurn. The `character` is derived once for the rail.
 */
export function defineAgent(spec: AgentSpec): AgentDefinition {
  if (!isNonEmptyString(spec.name)) {
    throw new Error('defineAgent: "name" must be a non-empty string');
  }
  if (
    !Array.isArray(spec.bio) ||
    spec.bio.length === 0 ||
    !spec.bio.every(isNonEmptyString)
  ) {
    throw new Error('defineAgent: "bio" must be a non-empty array of non-empty strings');
  }
  if (spec.systemPrompt !== undefined && !isNonEmptyString(spec.systemPrompt)) {
    throw new Error('defineAgent: "systemPrompt", if present, must be a non-empty string');
  }
  if (
    spec.templateCategoryIds !== undefined &&
    (!Array.isArray(spec.templateCategoryIds) ||
      !spec.templateCategoryIds.every(isNonEmptyString))
  ) {
    throw new Error(
      'defineAgent: "templateCategoryIds", if present, must be an array of non-empty strings',
    );
  }
  if (
    spec.evaluators !== undefined &&
    (!Array.isArray(spec.evaluators) || !spec.evaluators.every(isNonEmptyString))
  ) {
    throw new Error('defineAgent: "evaluators", if present, must be an array of non-empty strings');
  }
  if (spec.scoreless !== undefined && typeof spec.scoreless !== "boolean") {
    throw new Error('defineAgent: "scoreless", if present, must be a boolean');
  }

  const skills = spec.skills ?? [];
  if (!Array.isArray(skills)) {
    throw new Error('defineAgent: "skills", if present, must be an array of skills');
  }
  const seen = new Set<string>();
  for (const skill of skills) {
    if (skill === null || typeof skill !== "object" || !isNonEmptyString(skill.name)) {
      throw new Error('defineAgent: every entry in "skills" must be a skill with a non-empty name');
    }
    if (seen.has(skill.name)) {
      throw new Error(`defineAgent: duplicate skill name "${skill.name}" in skills`);
    }
    seen.add(skill.name);
  }

  // Tools: unique among themselves AND disjoint from skill names. One capability
  // namespace per agent — a name that means "skill" in one log line and "tool" in
  // another is an authoring bug, so it throws here at the definition site.
  const tools = spec.tools ?? [];
  if (!Array.isArray(tools)) {
    throw new Error('defineAgent: "tools", if present, must be an array of tools');
  }
  const seenTools = new Set<string>();
  for (const tool of tools) {
    if (tool === null || typeof tool !== "object" || !isNonEmptyString(tool.name)) {
      throw new Error('defineAgent: every entry in "tools" must be a tool with a non-empty name');
    }
    if (seenTools.has(tool.name)) {
      throw new Error(`defineAgent: duplicate tool name "${tool.name}" in tools`);
    }
    if (seen.has(tool.name)) {
      throw new Error(
        `defineAgent: name "${tool.name}" is declared as both a skill and a tool; ` +
          `skill and tool names share one namespace per agent`,
      );
    }
    seenTools.add(tool.name);
  }

  // Models: shape-check only (duplicates are legal retries; keys resolve lazily later).
  const models = spec.models ?? [];
  if (!Array.isArray(models)) {
    throw new Error('defineAgent: "models", if present, must be an array of ModelSpecs');
  }
  for (const m of models) {
    if (
      m === null || typeof m !== "object" ||
      typeof m.provider !== "string" || m.provider.trim().length === 0 ||
      typeof m.model !== "string" || m.model.trim().length === 0
    ) {
      throw new Error(
        'defineAgent: every entry in "models" must be a ModelSpec with non-empty provider and model',
      );
    }
  }

  // Derive the rail-facing character ONCE. Trim identity strings to match parseCharacter's
  // normalization; include optional fields only when present. The broad pre-filter SCOPE
  // (capabilities) is built here from the declared template categories + evaluator binding, so the
  // menu's prefilterCandidates narrows to templates this agent can actually serve. This wires the
  // folding character.ts documents (templateCategoryIds -> capabilities.categories) which was
  // previously only honored for character FILES, plus the new granular evaluator binding.
  const categories = spec.templateCategoryIds?.map((id) => id.trim());
  const evaluatorFamilies = spec.evaluators?.map((e) => e.trim());
  const capabilities: AgentCapabilities | undefined =
    categories !== undefined || evaluatorFamilies !== undefined
      ? {
          ...(categories !== undefined ? { categories } : {}),
          ...(evaluatorFamilies !== undefined ? { evaluatorFamilies } : {}),
        }
      : undefined;

  const character: AgentCharacter = {
    name: spec.name.trim(),
    bio: spec.bio.map((line) => line.trim()),
    ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt.trim() } : {}),
    ...(categories !== undefined ? { templateCategoryIds: categories } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
  };

  return {
    name: character.name,
    bio: character.bio,
    ...(character.systemPrompt !== undefined ? { systemPrompt: character.systemPrompt } : {}),
    ...(character.templateCategoryIds !== undefined
      ? { templateCategoryIds: character.templateCategoryIds }
      : {}),
    ...(evaluatorFamilies !== undefined ? { evaluators: evaluatorFamilies } : {}),
    scoreless: spec.scoreless === true,
    skills,
    tools,
    models,
    ...(spec.onTurn !== undefined ? { onTurn: spec.onTurn } : {}),
    character,
  };
}
