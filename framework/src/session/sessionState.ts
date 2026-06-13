// sessionState.ts — immutable per-session state + the INJECT-ONCE invariant: a
// recalled prior-session summary is injected on turn 1 only (leaking into later
// turns compounds stale context and silently drifts the model). "Consumed once" is
// an explicit immutable transition (summaryForThisTurn reads; consumeRecalledSummary
// returns a new state with the flag flipped), so it is unit-testable with no runtime.

/**
 * Immutable per-session state carried across turns. Transitions return a NEW object.
 */
export interface AgentSessionState {
  /** The derived room/namespace id for this (user, agent) session. */
  readonly roomId: string;
  /** Index-key user identity for this session. */
  readonly user: string;
  /** Index-key agent identity for this session. */
  readonly agent: string;
  /**
   * The recalled prior-session summary, if a checkpoint was resumed. Absent on a
   * fresh first run. Its single-injection is governed by recalledSummaryConsumed.
   */
  readonly recalledSummary?: string;
  /**
   * False at session start; flipped to true once turn 1 has read the summary via
   * summaryForThisTurn. The guard behind the "inject exactly once" invariant.
   */
  readonly recalledSummaryConsumed: boolean;
  /** The rendered job-template block, if this agent offers templates. */
  readonly templatesText?: string;
}

/** Inputs to start a fresh session. The consumed flag is NOT an input — a fresh
 *  session always begins unconsumed. */
export interface CreateSessionStateInput {
  readonly roomId: string;
  readonly user: string;
  readonly agent: string;
  readonly recalledSummary?: string;
  readonly templatesText?: string;
}

/**
 * Build a fresh AgentSessionState. recalledSummaryConsumed is ALWAYS false here:
 * a new session has not yet had a chance to inject its recalled summary. Pure; the
 * returned object is a new value built only from the inputs (no I/O, no clock).
 */
export function createSessionState(input: CreateSessionStateInput): AgentSessionState {
  return {
    roomId: input.roomId,
    user: input.user,
    agent: input.agent,
    recalledSummary: input.recalledSummary,
    templatesText: input.templatesText,
    recalledSummaryConsumed: false,
  };
}

// A summary that is absent, empty, or whitespace-only carries no resumable context,
// so it must never be injected — treating it as "present" would inject a blank
// resumedSummary and still burn the one-shot consume on nothing.
function hasInjectableSummary(summary: string | undefined): summary is string {
  return typeof summary === "string" && summary.trim().length > 0;
}

/**
 * The recalled summary to inject on THIS turn, or undefined. Returns the summary
 * ONLY while it has not yet been consumed AND it is a non-empty, non-whitespace
 * string; otherwise undefined. This is the value the rail passes to
 * respond({ resumedSummary }). Pure and side-effect-free: it does NOT consume —
 * consuming is the explicit separate transition below, so reading is idempotent.
 */
export function summaryForThisTurn(state: AgentSessionState): string | undefined {
  if (state.recalledSummaryConsumed) return undefined;
  if (!hasInjectableSummary(state.recalledSummary)) return undefined;
  return state.recalledSummary;
}

/**
 * Mark the recalled summary as consumed. Returns a NEW AgentSessionState with
 * recalledSummaryConsumed: true and every other field unchanged — the input is
 * NEVER mutated. Idempotent: applied to an already-consumed state it returns an
 * equivalent already-consumed state. After this, summaryForThisTurn returns
 * undefined, so turn 2 onward never re-injects the recalled summary.
 */
export function consumeRecalledSummary(state: AgentSessionState): AgentSessionState {
  if (state.recalledSummaryConsumed) return state;
  return { ...state, recalledSummaryConsumed: true };
}
