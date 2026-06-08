// Fake job templates for the demo, stored ON Walrus (not hardcoded into the agent
// at runtime). The agent's ONLY domain knowledge is this template set: it reads
// them from a Walrus blob, matches a user's request to the closest one, and
// collects the template's parameters conversationally.
//
// Shape note: `job_template` is the canonical contract shape the team agreed on
// ({ output, lifetime }). The agent-facing fields (category_id, title, params)
// are what the assistant reasons over and asks the user about. The raw template
// must NEVER be shown verbatim to the user -- renderTemplatesForPrompt produces a
// readable description for the SYSTEM PROMPT only.

import { storeBlob, readBlob, type WalrusHttpConfig } from "./walrusHttp.js";

/** A single conversationally-collected parameter. */
export interface JobParam {
  /** The natural-language question the agent asks to collect this value. */
  readonly ask: string;
  /** The value's shape, used only to guide the agent (never shown raw). */
  readonly type: "string" | "number" | "duration";
}

/** A job the agent can recognize, confirm, and collect parameters for. */
export interface JobTemplate {
  /** Stable machine id, e.g. "btc-price-guess". Internal; not shown to the user. */
  readonly category_id: string;
  /** Human label used when confirming the match, e.g. "Cryptocurrency price...". */
  readonly title: string;
  /** Required parameters keyed by name; each carries its natural question. */
  readonly params: Record<string, JobParam>;
  /** Canonical team-contract job shape. Internal; never shown to the user. */
  readonly job_template: {
    readonly output: Record<string, "number" | "string">;
    readonly lifetime: string;
  };
}

// Two fake-but-canonical templates. Kept small and readable on purpose.
export const DEMO_TEMPLATES: readonly JobTemplate[] = [
  {
    category_id: "btc-price-guess",
    title: "Cryptocurrency price-range prediction",
    params: {
      asset: { ask: "Which cryptocurrency should I predict?", type: "string" },
      horizon: {
        ask: "Over what time window should I predict the range?",
        type: "duration",
      },
    },
    job_template: {
      output: { minPrice: "number", maxPrice: "number" },
      lifetime: "5m",
    },
  },
  {
    category_id: "polymarket-resolution",
    title: "Polymarket market resolution",
    params: {
      market: { ask: "Which Polymarket market or question should I resolve?", type: "string" },
      resolveBy: { ask: "By when should it resolve?", type: "duration" },
    },
    job_template: {
      output: { outcome: "string" },
      lifetime: "1h",
    },
  },
];

/**
 * JSON-encode the template array and store it on Walrus. Returns the blobId.
 * Propagates WalrusHttpError on any storage failure (no local fallback).
 */
export async function seedTemplates(
  walrusCfg: WalrusHttpConfig,
  templates: readonly JobTemplate[] = DEMO_TEMPLATES,
): Promise<{ blobId: string }> {
  const bytes = new TextEncoder().encode(JSON.stringify(templates));
  return storeBlob(walrusCfg, bytes);
}

/**
 * Read the template array back from Walrus and parse it. Propagates
 * WalrusHttpError on read failure; throws a clear Error if the blob is not a
 * JSON array of templates.
 */
export async function loadTemplates(
  walrusCfg: WalrusHttpConfig,
  blobId: string,
): Promise<JobTemplate[]> {
  const bytes = await readBlob(walrusCfg, blobId);
  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Templates blob ${blobId} was not valid JSON: ${String(cause)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Templates blob ${blobId} did not contain a JSON array.`);
  }
  return parsed as JobTemplate[];
}

/**
 * Render a compact, READABLE description of each template for injection into the
 * system prompt. This is what the agent reasons over to match and collect
 * parameters. It must NEVER be shown verbatim to the user.
 */
export function renderTemplatesForPrompt(templates: readonly JobTemplate[]): string {
  return templates
    .map((tpl, index) => {
      const questions = Object.entries(tpl.params)
        .map(([name, p]) => `      - ${name} (${p.type}): "${p.ask}"`)
        .join("\n");
      const output = Object.entries(tpl.job_template.output)
        .map(([name, type]) => `${name} (${type})`)
        .join(", ");
      return [
        `  ${index + 1}. ${tpl.title} [id: ${tpl.category_id}]`,
        `     Parameters to collect:`,
        questions,
        `     Produces: ${output}`,
        `     Validity window: ${tpl.job_template.lifetime}`,
      ].join("\n");
    })
    .join("\n\n");
}
