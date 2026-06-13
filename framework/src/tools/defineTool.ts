// defineTool.ts — the plain-function tool primitive: a developer's own algorithm the
// LLM decides WHEN to run (vs a skill, which onTurn dispatches deterministically). The
// handler is a PLAIN FUNCTION (validated input -> JSON-serializable value): no ctx, no
// framework types — it runs on the server side of the MCP seam and stays unit-testable;
// inject deps by closing over them. Pure construction; execution is the toolServer
// boundary (failures become typed ToolError values, not throws).

import type { z } from "zod";

/** What a developer hands to defineTool. `input` MUST be a z.object(...) (MCP args are a
 *  named JSON object); `description` is rendered to the LLM verbatim. */
export interface ToolDefinition<S extends z.ZodObject<z.ZodRawShape>> {
  readonly name: string;
  readonly description: string;
  readonly input: S;
  /** The developer's plain function: validated input in, JSON-serializable value out. */
  readonly handler: (input: z.output<S>) => unknown | Promise<unknown>;
}

/** The constructed tool (a distinct named type, mirroring Skill vs SkillDefinition). */
export interface Tool<S extends z.ZodObject<z.ZodRawShape>> {
  readonly name: string;
  readonly description: string;
  readonly input: S;
  readonly handler: (input: z.output<S>) => unknown | Promise<unknown>;
}

/** A tool of any input shape, for heterogeneous collections (same variance rationale as
 *  AnySkill; collected tools are only read for registration, never called with a typed arg). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any>;

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`defineTool: "${field}" must be a non-empty string`);
  }
}

// lower_snake_case identity, same grammar as skill names (own copy so the error names
// defineTool). It's the MCP registration name and what the LLM emits in {"tool": ...}.
const TOOL_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** Assert a string is a valid lower_snake_case tool name. */
export function assertValidToolName(name: string): void {
  if (!TOOL_NAME_RE.test(name)) {
    throw new Error(
      `defineTool: invalid tool name "${name}": use lower_snake_case ` +
        `(e.g. "fetch_btc_price") — start with a letter, only [a-z0-9_], no ` +
        `leading/trailing or doubled underscores`,
    );
  }
}

/** Construct a Tool: PURE — validates name/description/object-schema and captures the
 *  fields; never executes the handler or parses input (the toolServer boundary's job). */
export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(
  def: ToolDefinition<S>,
): Tool<S> {
  requireNonEmpty(def.name, "name");
  assertValidToolName(def.name);
  requireNonEmpty(def.description, "description");
  // Duck-check z.object(...) (a non-object schema would advertise a bad contract to the LLM).
  const shape = (def.input as { shape?: unknown }).shape;
  if (shape === null || typeof shape !== "object") {
    throw new Error(
      `defineTool: "${def.name}" input must be a z.object(...) schema — ` +
        `MCP tool arguments are a named JSON object`,
    );
  }
  return {
    name: def.name,
    description: def.description,
    input: def.input,
    handler: def.handler,
  };
}
