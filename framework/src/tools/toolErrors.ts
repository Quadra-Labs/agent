// toolErrors.ts — typed tool-execution failures ToolPort.call returns instead of
// throwing, so the loop can render them as observations the model recovers from. A
// separate union from SkillError (different dispatchers, vocabularies kept apart).
//   tool_not_found     — name not in the manifest (caught client-side).
//   tool_input_invalid — args failed the zod input schema (caught client-side; handler
//                        never ran).
//   tool_run_failed    — handler threw / result malformed / protocol rejected; `cause`
//                        preserves the original.
// Budget exhaustion is NOT an error here — that's ToolLoopResult.forcedFinal.

/**
 * A typed tool-execution failure. Returned by ToolPort.call instead of throwing.
 * Discriminated on `kind`; every variant carries the `toolName` it concerns and a
 * human-readable `message` (which the tool loop renders into the model's observation).
 */
export type ToolError =
  | {
      readonly kind: "tool_not_found";
      readonly toolName: string;
      readonly message: string;
    }
  | {
      readonly kind: "tool_input_invalid";
      readonly toolName: string;
      readonly message: string;
      /** Flattened, readable summary of the zod validation problems on the arguments. */
      readonly issues: string;
    }
  | {
      readonly kind: "tool_run_failed";
      readonly toolName: string;
      readonly message: string;
      /** The original thrown/rejected value, preserved unchanged for callers to inspect. */
      readonly cause: unknown;
    };

/**
 * Build a "tool_not_found" error: the requested name is not in the agent's tools
 * manifest. Pure.
 */
export function toolNotFound(toolName: string): ToolError {
  return {
    kind: "tool_not_found",
    toolName,
    message: `tool "${toolName}" is not in this agent's tools manifest`,
  };
}

/**
 * Build a "tool_input_invalid" error: the arguments failed the tool's zod input
 * schema before the handler was ever called. Pure.
 */
export function toolInputInvalid(toolName: string, issues: string): ToolError {
  return {
    kind: "tool_input_invalid",
    toolName,
    issues,
    message: `tool "${toolName}" received invalid arguments: ${issues}`,
  };
}

/**
 * Build a "tool_run_failed" error: the handler threw, the MCP result was malformed,
 * or the protocol call rejected. The raw `cause` is kept unchanged; only the
 * `message` derives a readable form of it. Pure.
 */
export function toolRunFailed(toolName: string, cause: unknown): ToolError {
  const readable = cause instanceof Error ? cause.message : String(cause);
  return {
    kind: "tool_run_failed",
    toolName,
    cause,
    message: `tool "${toolName}" failed: ${readable}`,
  };
}
