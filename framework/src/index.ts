// Developer Agent Framework: the public surface for building agents over the sealed
// memory rails. Defines an agent in one file (defineAgent) and runs it (runAgent).

// The session rail + its API types. runAgent boots an AgentDefinition over the rail.
export {
  startAgentSession,
  runAgent,
  type AgentSession,
  type StartSessionInput,
  type RunAgentHost,
} from "./session/runAgent.js";

// The immutable session-state value + its inject-once transitions.
export {
  createSessionState,
  summaryForThisTurn,
  consumeRecalledSummary,
  type AgentSessionState,
  type CreateSessionStateInput,
} from "./session/sessionState.js";

// The agent identity type + the typed outcomes hosts branch on.
export type { AgentCharacter } from "../../app/src/character/character.js";
export type { CloseOutcome } from "../../app/src/session/closeSession.js";
export type { RecallOutcome } from "../../app/src/session/recallCheckpoint.js";

// The skill primitive + its dispatcher. assertValidSkillName is the name guard.
export {
  defineSkill,
  assertValidSkillName,
  type Skill,
  type SkillDefinition,
  type SkillContext,
  type SkillRun,
  type SkillRunArgs,
} from "./skills/defineSkill.js";

// The dispatcher: run a skill to a typed SkillResult + build the SkillContext.
export {
  runSkill,
  makeSkillContext,
  SkillCallError,
  type SkillResult,
  type AllowedSkills,
  type MakeSkillContextOptions,
} from "./skills/skillRunner.js";

// The outbound-network choke-point shared by SkillContext + LoopContext.
export { makeHttp } from "./http.js";

// The typed skill-error taxonomy the dispatcher surfaces.
export {
  inputInvalid,
  outputInvalid,
  runFailed,
  skillUndeclared,
  formatZodIssues,
  type SkillError,
} from "./errors.js";

// The narrow LoopContext (the seal) + the onTurn handler type.
export type {
  LoopContext,
  LoopModel,
  LoopHttp,
  TurnResult,
  OnTurn,
} from "./session/loopContext.js";

// The LoopContext builder. makeLoopModel is the sealed model wrapper over a runtime.
export {
  makeLoopContext,
  makeLoopModel,
  type MakeLoopContextInput,
} from "./session/makeLoopContext.js";

// The whole-agent definition primitive (one .ts file = a working agent).
export {
  defineAgent,
  type AgentSpec,
  type AgentDefinition,
} from "./session/defineAgent.js";

// The LLM-driven job producer: expose an agent's skills as tools and let the MODEL pick which to
// run to produce a job result (vs a hardcoded single-skill call). Used by the example bridges.
export { makeSkillProducer, type SkillProducerOptions } from "./session/skillProducer.js";

// The MCP-tools surface: developer plain functions the LLM decides to run, served by
// an in-process MCP server (never exposed publicly). Separate from skills.
export {
  defineTool,
  assertValidToolName,
  type Tool,
  type ToolDefinition,
  type AnyTool,
} from "./tools/defineTool.js";

// The in-process MCP server: start it over a tools manifest, get the sealed port.
export {
  startToolServer,
  type ToolPort,
  type ToolDescriptor,
  type ToolCallOutcome,
  type ToolServerHandle,
} from "./tools/toolServer.js";

// The typed tool-error taxonomy ToolPort.call returns instead of throwing.
export {
  toolNotFound,
  toolInputInvalid,
  toolRunFailed,
  type ToolError,
} from "./tools/toolErrors.js";

// The LLM tool loop (the "AI decides" turn) + the pure emission parser and prompt
// builders (exported so proofs can drive/assert the protocol without a model).
export {
  runToolLoop,
  parseModelEmission,
  type ToolLoopInput,
  type ToolLoopLimits,
  type ToolLoopResult,
  type ModelEmission,
  type ToolTranscriptEntry,
} from "./tools/toolLoop.js";
export {
  buildToolLoopPrompt,
  buildForcedFinalPrompt,
  TOOL_PROTOCOL_MARKER,
  type ToolPromptInput,
} from "./tools/toolPrompt.js";

// The multi-provider model layer: per-agent base model + fallback chain over raw
// fetch. Keys resolve lazily from env at call time; every provider key is optional.
export {
  openai,
  anthropic,
  groq,
  openrouter,
  zai,
  local,
  custom,
  makeProviderModel,
  makeModelChain,
  describeModels,
  hasUsableProvider,
  type ModelSpec,
  type ProviderName,
  type ProviderOptions,
  type ProviderModelOptions,
  type ModelChainOptions,
} from "./models.js";

// OPTIONAL: the skill -> ElizaOS Action compiler (additive; the host registers the
// produced Action[], ctx.callSkill is unchanged).
export {
  compileSkillToAction,
  compileSkills,
  actionNameForSkill,
  type CompileSkillOptions,
  type CompiledSkillSuccessData,
  type CompiledSkillErrorData,
} from "./skills/compileSkill.js";
