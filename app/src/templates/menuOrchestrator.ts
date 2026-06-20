// menuOrchestrator.ts — the boot/refresh entry that produces the agent's offerable job menu.
// Walrus (the gateway's job_templates doc) is the SOURCE OF TRUTH; MemWal caches the
// filtered menu. Flow: fetch the doc -> compare its content hash to the cached menu's
// sourceHash (cheap, index-only) -> on a match serve the cache, else REBUILD (parse rich
// templates, skip non-intake-ready ones, broad pre-filter, agent self-selection) and write
// the new menu to MemWal. A gateway outage degrades to the last good cached menu. NEVER
// throws. The returned templates carry the REAL data-layer id, so submitJob's template_id is
// valid downstream.

import type { IAgentRuntime } from "@elizaos/core";

import type { AgentCharacter } from "../character/character.js";
import { fetchJobTemplates, type FetchTemplatesResult } from "./templatesReader.js";
import {
  parseIntakeTemplates,
  renderIntakeTemplatesForPrompt,
  type IntakeTemplate,
} from "./intakeTemplate.js";
import { prefilterCandidates, selfSelectTemplates } from "./templateSelector.js";
import type {
  MenuRecord,
  MenuTemplate,
  ReadMenuResult,
  WriteMenuResult,
} from "../../../plugins/plugin-memwal/src/menuTypes.js";

// The MemWal slice this module drives — resolved structurally from getService("memwal"),
// mirroring closeSession.ts/recallCheckpoint.ts (app depends on the runtime contract, not
// the plugin class). The menu result TYPES are imported from the plugin's types directly.
type MemwalMenuStore = {
  latestMenuMeta(
    agent: string,
  ): Promise<{ blobId: string; sourceHash: string; createdAt: number } | undefined>;
  readLatestMenu(agent: string): Promise<ReadMenuResult>;
  writeMenu(menu: MenuRecord): Promise<WriteMenuResult>;
};

function resolveMenuStore(runtime: IAgentRuntime): MemwalMenuStore | undefined {
  const svc = runtime.getService("memwal");
  if (svc === undefined || svc === null) return undefined;
  return svc as unknown as MemwalMenuStore;
}

export interface ResolveMenuInput {
  readonly runtime: IAgentRuntime;
  readonly character: AgentCharacter;
  readonly dataGatewayUrl: string;
  /** Min confidence for an accept to be offerable (passed to self-selection). */
  readonly threshold?: number;
  /** Provenance label for the model that made the self-selection decisions. */
  readonly selectorModel?: string;
  /** Injectable clock (tests). Defaults to Date.now. */
  readonly now?: () => number;
}

export interface ResolvedMenu {
  /** Rendered system-prompt block, or undefined when the menu is empty. */
  readonly text: string | undefined;
  /** The offerable templates (real data-layer ids). */
  readonly templates: readonly IntakeTemplate[];
  readonly source: "cache" | "rebuilt" | "cache_fallback" | "empty";
  /** User-facing boot notes (skips, self-selection counts, cache state). */
  readonly notes: readonly string[];
}

function textOf(templates: readonly IntakeTemplate[]): string | undefined {
  return templates.length > 0 ? renderIntakeTemplatesForPrompt(templates) : undefined;
}

// Re-validate cached menu templates back into typed IntakeTemplates (narrows the menu's
// widened types and drops anything that no longer conforms). A clean cache round-trips fully.
function menuToIntake(templates: readonly MenuTemplate[]): IntakeTemplate[] {
  const parsed = parseIntakeTemplates(templates as unknown);
  return parsed.ok ? parsed.templates : [];
}

function intakeToMenuTemplate(t: IntakeTemplate): MenuTemplate {
  return {
    id: t.id,
    category: t.category,
    evaluator_id: t.evaluator_id,
    description: t.description,
    params: Object.fromEntries(
      Object.entries(t.params).map(([k, p]) => [
        k,
        {
          ask: p.ask,
          type: p.type,
          ...(p.validation !== undefined
            ? { validation: p.validation as unknown as Record<string, unknown> }
            : {}),
        },
      ]),
    ),
    output: t.output,
    // Carry scoreless / lifetime / minimum_lifetime / allowed_assets so a cache-served menu
    // round-trips them (menuToIntake re-parses via parseIntakeTemplates, which reads these
    // fields). Without scoreless, a cached scoreless template would re-parse as scored and be
    // dropped for its empty evaluator_id.
    ...(t.scoreless ? { scoreless: true } : {}),
    ...(t.lifetime !== undefined ? { lifetime: t.lifetime } : {}),
    ...(t.minimumLifetimeMs !== undefined ? { minimum_lifetime: t.minimumLifetimeMs } : {}),
    ...(t.allowedAssets && t.allowedAssets.length > 0 ? { allowed_assets: t.allowedAssets } : {}),
  };
}

// Boot-time template fetch with bounded retries on a TRANSIENT network_error. The remote data
// gateway does a Walrus-backed read for /templates that routinely takes ~10s and can spike past the
// timeout on a cold start (e.g. the agent booting right after the engines come up), which surfaces
// as a single network_error. Without a retry that one blip leaves the whole session with no menu
// ("offering no jobs") and, on a first run, no cache to fall back to. Only network_error is
// retried (it is the sole retryable kind); an unexpected_status (4xx/5xx) or invalid_body will not
// fix itself, so those return immediately. A genuinely-down gateway fails fast (connection refused)
// so the retries add little; a slow one gets the extra chances it needs.
const TEMPLATE_FETCH_ATTEMPTS = 3;
const TEMPLATE_FETCH_BACKOFF_MS = 2_000;

async function fetchTemplatesWithRetry(dataGatewayUrl: string): Promise<FetchTemplatesResult> {
  let last = await fetchJobTemplates(dataGatewayUrl);
  for (
    let attempt = 1;
    attempt < TEMPLATE_FETCH_ATTEMPTS && !last.ok && last.kind === "network_error";
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, TEMPLATE_FETCH_BACKOFF_MS * attempt));
    last = await fetchJobTemplates(dataGatewayUrl);
  }
  return last;
}

/**
 * Resolve the agent's offerable menu for this session. NEVER throws.
 */
export async function resolveMenu(input: ResolveMenuInput): Promise<ResolvedMenu> {
  const { runtime, character, dataGatewayUrl } = input;
  const agent = character.name;
  const notes: string[] = [];
  const store = resolveMenuStore(runtime);

  // 1. Fetch the source doc (retrying a transient network_error). An outage that survives the
  //    retries falls back to the last good cached menu.
  const fetched = await fetchTemplatesWithRetry(dataGatewayUrl);
  if (!fetched.ok) {
    if (store !== undefined) {
      const cached = await store.readLatestMenu(agent);
      if (cached.ok) {
        const templates = menuToIntake(cached.menu.templates);
        notes.push(`Templates unreachable (${fetched.kind}); using the cached menu (${templates.length} job(s)).`);
        return { templates, text: textOf(templates), source: "cache_fallback", notes };
      }
    }
    notes.push(`Templates unreachable (${fetched.kind}); no cached menu — offering no jobs.`);
    return { templates: [], text: undefined, source: "empty", notes };
  }

  // 2. Cheap staleness check: stored sourceHash vs the fresh fetch. Match -> serve cache.
  if (store !== undefined) {
    const meta = await store.latestMenuMeta(agent);
    if (meta !== undefined && meta.sourceHash === fetched.fetched.sourceHash) {
      const cached = await store.readLatestMenu(agent);
      if (cached.ok) {
        const templates = menuToIntake(cached.menu.templates);
        return { templates, text: textOf(templates), source: "cache", notes };
      }
      // Unreadable/invalid cache -> fall through to rebuild.
    }
  }

  // 3. Rebuild: parse (skip non-intake-ready) -> pre-filter -> self-select -> cache.
  const parsed = parseIntakeTemplates(fetched.fetched.raw);
  if (!parsed.ok) {
    notes.push(`Templates payload was not a valid job-templates document (${parsed.kind}); offering no jobs.`);
    return { templates: [], text: undefined, source: "empty", notes };
  }
  if (parsed.skipped.length > 0) {
    notes.push(`${parsed.skipped.length} template(s) skipped as not intake-ready.`);
  }

  const candidates = prefilterCandidates(parsed.templates, character.capabilities);
  const selected = await selfSelectTemplates({ runtime, character, candidates, threshold: input.threshold });
  const accepted = selected.accepted;
  notes.push(`Self-selected ${accepted.length} of ${candidates.length} candidate template(s) to offer.`);

  if (store !== undefined) {
    const menu: MenuRecord = {
      agent,
      templates: accepted.map(intakeToMenuTemplate),
      sourceHash: fetched.fetched.sourceHash,
      ...(fetched.fetched.sourceUpdatedAt !== undefined
        ? { sourceUpdatedAt: fetched.fetched.sourceUpdatedAt }
        : {}),
      // Provenance: where the source came from + every self-selection decision, so a
      // disputed accept/reject is debuggable (template changed vs model vs prompt).
      sourceGatewayUrl: dataGatewayUrl,
      sourceTemplateIds: parsed.templates.map((t) => t.id),
      selectorModel: input.selectorModel ?? "unknown",
      selections: selected.selections.map((s) => ({
        templateId: s.template.id,
        decision: s.decision,
        confidence: s.confidence,
        reason: s.reason,
      })),
      createdAt: (input.now ?? Date.now)(),
    };
    const write = await store.writeMenu(menu);
    if (!write.ok) {
      notes.push(`Menu cache write failed (${write.kind}); using it for this session only.`);
    }
  }

  return { templates: accepted, text: textOf(accepted), source: "rebuilt", notes };
}
