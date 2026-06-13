// defineAgent.ts — bind identity + skills + tools + models + optional onTurn into one
// AgentDefinition (one .ts file = a working agent). PURE construction: validates the
// definition shape (throws on a malformed one) and assembles the value; nothing touches
// the runtime. skills = the ctx.callSkill ALLOW-LIST (not auto-dispatch).

import type { AgentCharacter } from "../../../app/src/character/character.js";
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
  /** OPTIONAL job-template category ids the agent offers. */
  readonly templateCategoryIds?: readonly string[];
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

  // Derive the rail-facing character ONCE. Trim identity strings to match
  // parseCharacter's normalization; include optional fields only when present.
  const character: AgentCharacter = {
    name: spec.name.trim(),
    bio: spec.bio.map((line) => line.trim()),
    ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt.trim() } : {}),
    ...(spec.templateCategoryIds !== undefined
      ? { templateCategoryIds: spec.templateCategoryIds.map((id) => id.trim()) }
      : {}),
  };

  return {
    name: character.name,
    bio: character.bio,
    ...(character.systemPrompt !== undefined ? { systemPrompt: character.systemPrompt } : {}),
    ...(character.templateCategoryIds !== undefined
      ? { templateCategoryIds: character.templateCategoryIds }
      : {}),
    skills,
    tools,
    models,
    ...(spec.onTurn !== undefined ? { onTurn: spec.onTurn } : {}),
    character,
  };
}
