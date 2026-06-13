// loopContext.ts — the LoopContext TYPES: the narrow surface a developer's onTurn(ctx)
// may touch, and by what it omits, THE SEAL. It carries NO runtime/getService/MemWal/
// Walrus/DB/signer/process.env — none is a property, so none can be named. The seal is
// enforced by construction in makeLoopContext (runtime captured in a closure, never a
// field), not by this type. NOTE: an API/capability seal, NOT a process sandbox —
// onTurn still has ordinary JS/Node capabilities; real isolation is out of scope.

import type { SkillContext } from "../skills/defineSkill.js";
import type { ChatTurn } from "../../../app/src/chat/chatMemory.js";
import type { LoopHttp } from "../http.js";
import type { ToolPort } from "../tools/toolServer.js";

// Re-exported (LoopHttp lives in http.ts) so importers of it from here are unaffected.
export type { LoopHttp } from "../http.js";

/** The model wrapper the developer gets — never the raw runtime. */
export interface LoopModel {
  generate(prompt: string): Promise<string>;
}

/** What an onTurn returns: the reply text + which path produced it. */
export interface TurnResult {
  readonly text: string;
  /** "custom" (the developer's onTurn) or "default" (the framework loop). */
  readonly source: "custom" | "default";
}

/** The narrow context passed to onTurn(ctx). Extends SkillContext (callSkill verbatim)
 *  and adds only the members below — no runtime/services, unreachable by construction. */
export interface LoopContext extends SkillContext {
  /** The recent chat history for this turn, oldest-first. Read-only. */
  readonly history: readonly ChatTurn[];
  /** The recalled prior-session summary, if any (already inject-once-managed by the
   *  rail; here it is just readable context). Absent when none. */
  readonly recalledContext?: string;
  /** The user's message text for THIS turn. */
  readonly userMessage: string;
  /** Generate text via the framework model wrapper (NOT the raw runtime). */
  readonly model: LoopModel;
  /** Bounded outbound HTTP (the future capability choke-point). */
  readonly http: LoopHttp;
  /** The agent's in-process MCP tool port (the tools workstream) — list/call the
   *  declared tools. PRESENT ONLY when the agent declared tools; absent otherwise.
   *  The port's MCP client lives in a closure, so this adds no privileged surface. */
  readonly tools?: ToolPort;
  /** Produce a reply as the turn result (source: "custom"). */
  reply(text: string): TurnResult;
  /** Fall back to the framework default loop (source: "default") — the chat loop, or
   *  the LLM tool loop when the agent declared tools. */
  defaultReply(): Promise<TurnResult>;
  // callSkill is inherited from SkillContext.
}

/** The developer's turn handler: narrow LoopContext in, TurnResult out (sync or async). */
export type OnTurn = (ctx: LoopContext) => Promise<TurnResult> | TurnResult;
