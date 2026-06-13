// makeLoopContext.ts — the ONLY builder of a LoopContext, where the seal is enforced:
// the runtime (and everything reachable through it) is captured in CLOSURES and never
// assigned as a property, so onTurn cannot name or cast its way back to it. callSkill is
// taken verbatim from makeSkillContext (identical semantics).

import { ModelType } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import type { ChatTurn } from "../../../app/src/chat/chatMemory.js";
import type {
  LoopContext,
  LoopModel,
  TurnResult,
} from "./loopContext.js";
import type { LoopHttp } from "../http.js";
import { makeSkillContext, type AllowedSkills } from "../skills/skillRunner.js";
import type { ToolPort } from "../tools/toolServer.js";

// plugin-groq returns this sentinel instead of throwing; treat it as a hard failure.
const GROQ_ERROR_SENTINEL = "Error generating text. Please try again later.";

/**
 * The sealed LoopModel over a runtime: useModel(TEXT_LARGE), empty/sentinel -> throw.
 * The runtime lives only in this closure. Shared by ctx.model and the tool loop.
 */
export function makeLoopModel(runtime: IAgentRuntime): LoopModel {
  return {
    async generate(prompt: string): Promise<string> {
      const raw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
      const text = (typeof raw === "string" ? raw : String(raw ?? "")).trim();
      if (text.length === 0 || text === GROQ_ERROR_SENTINEL) {
        throw new Error(
          "model.generate failed (empty or model error). Check the model/key.",
        );
      }
      return text;
    },
  };
}

/** Everything the builder needs for one turn. `runtime` is captured in closures and
 *  NEVER exposed; `defaultReply` is injected so the builder doesn't depend on the rail. */
export interface MakeLoopContextInput {
  /** The privileged runtime — captured in closure ONLY; never exposed as a field. */
  readonly runtime: IAgentRuntime;
  /** Recent chat turns for this turn, oldest-first, read-only. */
  readonly history: readonly ChatTurn[];
  /** The recalled prior-session summary, if any. */
  readonly recalledContext?: string;
  /** The user's message text for THIS turn. */
  readonly userMessage: string;
  /** The default-loop fallback for this turn, called by ctx.defaultReply(). */
  readonly defaultReply: () => Promise<TurnResult>;
  /** OPTIONAL ctx.callSkill allow-list (by identity); omitted -> any skill callable. */
  readonly allowedSkills?: AllowedSkills;
  /** OPTIONAL injected http, SHARED by ctx.http and ctx.callSkill; omitted -> default. */
  readonly http?: LoopHttp;
  /** OPTIONAL in-process MCP tool port (present only when the agent declared tools). */
  readonly tools?: ToolPort;
  /** OPTIONAL session model override (the provider chain); absent -> makeLoopModel(runtime). */
  readonly model?: LoopModel;
}

/** Build the narrow LoopContext: the returned object exposes ONLY LoopContext members;
 *  the runtime lives solely in the model/http closures. */
export function makeLoopContext(input: MakeLoopContextInput): LoopContext {
  // callSkill + http come verbatim from makeSkillContext; the allow-list + injected http
  // are threaded so ctx and the skills it calls share one http instance.
  const skillCtx = makeSkillContext({ allowed: input.allowedSkills, http: input.http });

  // The provider chain when configured, else the sealed runtime wrapper.
  const model: LoopModel = input.model ?? makeLoopModel(input.runtime);

  // Only LoopContext members; no runtime field. recalledContext/tools are conditionally
  // spread so the keys exist only when present.
  const ctx: LoopContext = {
    callSkill: skillCtx.callSkill,
    history: input.history,
    ...(input.recalledContext !== undefined
      ? { recalledContext: input.recalledContext }
      : {}),
    userMessage: input.userMessage,
    model,
    http: skillCtx.http,
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    reply(text: string): TurnResult {
      return { text, source: "custom" };
    },
    defaultReply: input.defaultReply,
  };

  return ctx;
}
