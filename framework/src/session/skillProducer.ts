// skillProducer.ts — turn an agent's declared skills into an LLM-DRIVEN job producer. Instead of a
// hardcoded call to one skill, the MODEL decides which of the developer's skills to run to satisfy
// a job: each skill is exposed as a tool over the in-process MCP server, runToolLoop lets the model
// pick + call them, and the model's final JSON is returned. The caller (produceAndSealResult)
// validates that JSON against the template's output schema before sealing — so a weak strategy
// simply scores low. Strategy quality is the developer's responsibility, not the platform's.
//
// Dependency direction is preserved: this is framework code that imports app TYPES only (the same
// way loopContext.ts imports ChatTurn). The model is built by the app (from its runtime) and handed
// in via the produce hook's `model` arg, so the app never imports the framework at runtime.

import type { z } from "zod";

import { makeHttp } from "../http.js";
import { makeSkillContext, runSkill } from "../skills/skillRunner.js";
import type { Skill } from "../skills/defineSkill.js";
import { defineTool, type AnyTool } from "../tools/defineTool.js";
import { startToolServer } from "../tools/toolServer.js";
import { runToolLoop, type ToolLoopLimits } from "../tools/toolLoop.js";
import type { JobResult, ProduceHook } from "../../../app/src/jobs/jobResult.js";
import type { IntakeTemplate } from "../../../app/src/templates/intakeTemplate.js";

// Heterogeneous skill collection (same variance rationale as AnyTool): skills are only read to
// build tools here, never invoked with a typed arg.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySkill = Skill<any, any>;

/** The producer's system prompt: the job, its inputs, and the EXACT output schema the model must
 *  emit. The tool-loop prompt already advertises each skill (name/description/JSON schema), so this
 *  only adds the job context + the result contract. */
function buildProducerPrompt(template: IntakeTemplate, collected: Record<string, string>): string {
  const schema = Object.entries(template.output)
    .map(([k, t]) => `  - ${k} (${t})`)
    .join("\n");
  const inputs = Object.entries(collected)
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join("\n");
  return [
    `You are completing a paid job: "${template.description}".`,
    "You have tools (your developer-defined skills). DECIDE which to call, call them to compute",
    "the answer, then STOP and give your final answer.",
    "",
    "Job inputs:",
    inputs.length > 0 ? inputs : "  (none)",
    "",
    "Your FINAL answer must be a single JSON object with EXACTLY these keys and value types:",
    schema,
    "A number field must be a JSON number, a string field a JSON string; no extra keys, no prose.",
  ].join("\n");
}

/** Extract the first balanced JSON object from text and parse it; null if none/invalid. */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface SkillProducerOptions {
  /** Tool-loop budgets (forwarded to runToolLoop). Defaults to the loop's own limits. */
  readonly limits?: ToolLoopLimits;
}

/**
 * makeSkillProducer — build a ProduceHook in which the MODEL chooses which of `skills` to run to
 * produce a job's result. Returns ok:false (so the job is not delivered) when no model was provided
 * or the model emitted no JSON object; otherwise returns the parsed object for the caller to
 * validate against the template's output schema. NEVER throws.
 */
export function makeSkillProducer(
  skills: readonly AnySkill[],
  options?: SkillProducerOptions,
): ProduceHook {
  return async ({ template, collected, model }) => {
    if (model === undefined) {
      return { ok: false, reason: "no model available to drive skill selection" };
    }
    const ctx = makeSkillContext({ http: makeHttp() });
    const tools: AnyTool[] = skills.map((skill) =>
      defineTool({
        name: skill.name,
        description: skill.description,
        // Skill inputs are z.object(...) in practice (a tool's MCP args are a named JSON object).
        input: skill.input as unknown as z.ZodObject<z.ZodRawShape>,
        handler: async (input) => {
          const r = await runSkill(skill, input, ctx);
          if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
          return r.value;
        },
      }),
    );
    const server = await startToolServer(tools);
    try {
      const res = await runToolLoop({
        model,
        port: server.port,
        userMessage: "Complete the job now and return the result JSON.",
        history: [],
        systemPrompt: buildProducerPrompt(template, collected),
        ...(options?.limits ? { limits: options.limits } : {}),
      });
      const parsed = extractJsonObject(res.text);
      if (parsed === null) {
        return {
          ok: false,
          reason: `agent returned no JSON result (text: ${res.text.slice(0, 200)})`,
        };
      }
      return { ok: true, result: parsed as JobResult };
    } finally {
      await server.close();
    }
  };
}
