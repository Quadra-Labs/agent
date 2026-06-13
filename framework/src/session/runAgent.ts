// runAgent.ts — the reusable, injectable session rail: composes template resolution,
// recall seeding, per-turn respond, and checkpoint-on-close behind turn()/close().
// The CALLER owns the runtime lifecycle (boot + stop); the rail never creates it, so
// proofs can inject a fake/real runtime. Scope stops at chat + checkpoint-on-close.

import type { IAgentRuntime } from "@elizaos/core";

import {
  closeSession,
  type CloseOutcome,
} from "../../../app/src/closeSession.js";
import {
  recallCheckpoint,
  type RecallOutcome,
} from "../../../app/src/recallCheckpoint.js";
import type { AgentCharacter } from "../../../app/src/character.js";
import { listTurns } from "../../../app/src/chatMemory.js";
import {
  seedTemplates,
  loadTemplates,
  renderTemplatesForPrompt,
  type JobTemplate,
} from "../../../app/src/templates.js";

import {
  createSessionState,
  summaryForThisTurn,
  consumeRecalledSummary,
  type AgentSessionState,
} from "./sessionState.js";
import {
  defaultReplyText,
  persistTurnPair,
  assertValidTurnResult,
} from "./defaultTurn.js";
import { makeLoopContext, makeLoopModel } from "./makeLoopContext.js";
import type { LoopModel, OnTurn, TurnResult } from "./loopContext.js";
import type { AllowedSkills, AnySkill } from "../skills/skillRunner.js";
import type { AnyTool } from "../tools/defineTool.js";
import { makeModelChain, type ModelSpec } from "../models.js";
import { startToolServer, type ToolServerHandle } from "../tools/toolServer.js";
import { runToolLoop } from "../tools/toolLoop.js";
import type { LoopHttp } from "../http.js";
import type { AgentDefinition } from "./defineAgent.js";

/** Inputs to start a session. The runtime is booted by the caller; the rail never
 *  creates or stops it. `session` is the checkpoint index session key. */
export interface StartSessionInput {
  /** A runtime already booted by the caller (CLI / demo / proof). */
  readonly runtime: IAgentRuntime;
  /** The agent identity; `character.name` is the checkpoint index `agent` key. */
  readonly character: AgentCharacter;
  /** Index-key user identity for this session. */
  readonly user: string;
  /** The derived room/namespace id for this session's chat history. */
  readonly roomId: string;
  /** The session token used as the checkpoint index `session` key on close. */
  readonly session: string;
  /** OPTIONAL developer turn handler over a SEALED LoopContext. Absent -> the default
   *  loop. SAVE-FREE: the rail persists the user+agent pair once, after a good reply. */
  readonly onTurn?: OnTurn;
  /**
   * OPTIONAL declared-skill allow-list for ctx.callSkill (by identity); not auto-dispatch.
   * OMITTED vs EMPTY is load-bearing: undefined -> permissive (any skill callable);
   * an array (incl. []) -> the allow-list is exactly its members, so [] means DENY ALL.
   */
  readonly skills?: readonly AnySkill[];
  /** OPTIONAL injected outbound-HTTP wrapper, shared by the session's skills + onTurn.
   *  Omitted -> the default global-fetch http. */
  readonly http?: LoopHttp;
  /**
   * OPTIONAL declared tools (LLM-decided plain functions). Present (non-empty) -> the
   * rail boots ONE in-process MCP server (closed by close()), the default turn becomes
   * the tool loop, and onTurn sees the sealed port as ctx.tools. Unlike skills, omitted
   * and [] are EQUIVALENT (no server): tools are a manifest, not a call gate.
   */
  readonly tools?: readonly AnyTool[];
  /** OPTIONAL model chain (first = base, rest = fallbacks). Powers EVERY model call of
   *  the session (chat, tool loop, ctx.model, checkpoint summary). Omitted/[] -> the
   *  runtime's configured model. */
  readonly models?: readonly ModelSpec[];
}

/** A live session handle. `turn` runs one chat turn (recalled summary injected on turn
 *  1 only); `close` runs checkpoint-on-close; `recall` is the start-time outcome. */
export interface AgentSession {
  turn(text: string, onPrompt?: (prompt: string) => void): Promise<string>;
  close(): Promise<CloseOutcome>;
  /** The recall outcome resolved once at session start. Read-only. */
  readonly recall: RecallOutcome;
}

// Seed the default templates on Walrus, read back, keep only the character's
// categories. undefined when none/empty; a Walrus failure throws (fatal start error).
async function resolveTemplatesText(
  runtime: IAgentRuntime,
  character: AgentCharacter,
): Promise<string | undefined> {
  const wanted = character.templateCategoryIds ?? [];
  if (wanted.length === 0) return undefined;

  const seeded = await seedTemplates(runtime);
  if (!seeded.ok) {
    throw new Error(`Could not seed job templates on Walrus (${seeded.kind}): ${seeded.message}`);
  }
  const loaded = await loadTemplates(runtime, seeded.blobId);
  if (!loaded.ok) {
    throw new Error(`Could not load job templates from Walrus (${loaded.kind}): ${loaded.message}`);
  }

  const wantedSet = new Set(wanted);
  const selected: readonly JobTemplate[] = loaded.templates.filter((t) =>
    wantedSet.has(t.category_id),
  );
  if (selected.length === 0) return undefined;
  return renderTemplatesForPrompt(selected);
}

/**
 * Start a session over a CALLER-BOOTED runtime. At start this resolves the template
 * block ONCE (a Walrus failure throws a fatal start error the host catches), recalls
 * any prior checkpoint for (user, character.name), seeds the recalled summary when the
 * outcome is "recalled", and builds the initial immutable AgentSessionState. The
 * returned session carries the inject-once invariant (an internal holder swaps the
 * state reference each turn; the object is never mutated).
 */
export async function startAgentSession(
  input: StartSessionInput,
): Promise<AgentSession> {
  const { runtime, character, user, roomId, session } = input;
  const agent = character.name;

  // The declared-skill allow-list, built once. undefined -> permissive; a Set (incl.
  // empty) -> the allow-list is exactly its members, so [] is DENY ALL.
  const allowedSkills: AllowedSkills | undefined =
    input.skills === undefined ? undefined : new Set(input.skills);

  // ONE model for the whole session: the agent's provider chain when configured, else
  // the runtime's model. Keys resolve lazily per call (models.ts).
  const hasChain = input.models !== undefined && input.models.length > 0;
  const sessionModel: LoopModel = hasChain
    ? makeModelChain(input.models as readonly ModelSpec[])
    : makeLoopModel(runtime);

  // Resolve the optional template block once (fatal on a Walrus failure).
  const templatesText = await resolveTemplatesText(runtime, character);

  // Recall a prior checkpoint; seed the summary only when one resolved.
  const recall = await recallCheckpoint(runtime, { user, agent });
  const recalledSummary = recall.kind === "recalled" ? recall.summary : undefined;

  let currentState: AgentSessionState = createSessionState({
    roomId,
    user,
    agent,
    recalledSummary,
    templatesText,
  });

  // Boot the MCP tool server LAST (a fatal throw above never leaks a connected pair);
  // ONE per session, closed in close()'s finally.
  const toolServer: ToolServerHandle | undefined =
    input.tools !== undefined && input.tools.length > 0
      ? await startToolServer(input.tools)
      : undefined;

  const turn = async (
    text: string,
    onPrompt?: (prompt: string) => void,
  ): Promise<string> => {
    const summary = summaryForThisTurn(currentState);

    // SAVE-FREE default fallback: the tool loop with tools, else the byte-identical
    // default chat loop. ctx.defaultReply() keeps this meaning. The rail persists once.
    const defaultReply = async (): Promise<TurnResult> => {
      if (toolServer !== undefined) {
        const loop = await runToolLoop({
          model: sessionModel,
          port: toolServer.port,
          userMessage: text,
          history: await listTurns(runtime, roomId),
          recalledContext: summary,
          templatesText: currentState.templatesText,
          systemPrompt: character.systemPrompt,
          onPrompt,
        });
        return { text: loop.text, source: "default" };
      }
      const replyText = await defaultReplyText(runtime, {
        roomId,
        user,
        userMessage: text,
        resumedSummary: summary,
        templatesText: currentState.templatesText,
        systemPrompt: character.systemPrompt,
        onPrompt,
        model: sessionModel,
      });
      return { text: replyText, source: "default" };
    };

    let result: TurnResult;
    if (input.onTurn) {
      // ctx.history is the STORED history (current message is on ctx.userMessage; the
      // default branch appends it internally — do not double-append).
      const ctx = makeLoopContext({
        runtime,
        history: await listTurns(runtime, roomId),
        recalledContext: summary,
        userMessage: text,
        defaultReply,
        allowedSkills,
        model: sessionModel,
        ...(input.http !== undefined ? { http: input.http } : {}),
        ...(toolServer !== undefined ? { tools: toolServer.port } : {}),
      });
      result = await input.onTurn(ctx);
    } else {
      result = await defaultReply();
    }

    // Reject an invalid TurnResult before persistence; composed with persist-once,
    // an invalid result (or a thrown onTurn/model) persists NOTHING (no orphan turn).
    assertValidTurnResult(result);

    // Persist the user+agent PAIR exactly once, AFTER a successful reply.
    await persistTurnPair(runtime, {
      roomId,
      userText: text,
      agentText: result.text,
    });

    // Advance: a NEW state with the summary consumed, so turn 2 sees undefined.
    currentState = consumeRecalledSummary(currentState);
    return result.text;
  };

  // close() runs checkpoint-on-close (typed outcome returned unmodified); the tool
  // server is closed in a finally so the write is always attempted first.
  const close = async (): Promise<CloseOutcome> => {
    try {
      // With a chain, the checkpoint summary runs on it too (no runtime key needed).
      return await closeSession(runtime, {
        roomId,
        user,
        agent,
        session,
        ...(hasChain ? { summarize: (p: string) => sessionModel.generate(p) } : {}),
      });
    } finally {
      await toolServer?.close();
    }
  };

  return { turn, close, recall };
}

/** Host-supplied per-session context for runAgent(): the booted runtime + session
 *  keys. Separate from the definition so one agent serves many users/sessions. */
export interface RunAgentHost {
  /** A runtime already booted by the caller (CLI / demo / proof). */
  readonly runtime: IAgentRuntime;
  /** Index-key user identity for this session. */
  readonly user: string;
  /** The derived room/namespace id for this session's chat history. */
  readonly roomId: string;
  /** The session token used as the checkpoint index `session` key on close. */
  readonly session: string;
}

/** Boot a developer-authored AgentDefinition inside the rail: maps its pre-derived
 *  character / skills / tools / models / onTurn onto StartSessionInput. The host
 *  supplies the runtime + session keys. */
export function runAgent(
  agent: AgentDefinition,
  host: RunAgentHost,
): Promise<AgentSession> {
  return startAgentSession({
    runtime: host.runtime,
    character: agent.character,
    user: host.user,
    roomId: host.roomId,
    session: host.session,
    skills: agent.skills,
    tools: agent.tools,
    models: agent.models,
    ...(agent.onTurn !== undefined ? { onTurn: agent.onTurn } : {}),
  });
}
