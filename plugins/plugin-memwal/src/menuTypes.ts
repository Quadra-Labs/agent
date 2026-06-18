// menuTypes.ts — plugin-memwal's job-template MENU contract: the agent's self-selected,
// intake-ready job menu cached as a Walrus blob, SEPARATE from session Checkpoints. MemWal
// is NOT the source of truth — the record carries source metadata (sourceHash + optional
// updated_at / blob pointer) so staleness is detectable and the menu rebuildable from
// Walrus. Like the Checkpoint and WalrusLike structural mirrors, the plugin keeps its OWN
// copy of the menu shape (it must NOT import app types). Error `kind` names mirror the
// Walrus result unions so a Walrus failure maps straight through.

export interface MenuTemplate {
  readonly id: string;
  readonly category: string;
  readonly evaluator_id: string;
  readonly description: string;
  readonly params: Record<
    string,
    { ask: string; type: string; validation?: Record<string, unknown> }
  >;
  readonly output: Record<string, string>;
  /** Scoreless: paid on delivery, never scored. Carried so a cache-served menu still parses
   * the template as scoreless (it has no evaluator_id). */
  readonly scoreless?: boolean;
  /** Optional fixed validity window; newer templates omit it in favour of minimum_lifetime. */
  readonly lifetime?: string;
  /** Optional minimum lifetime (ms); carried so a cache-served menu still enforces the floor on
   * the user's chosen lifetime. */
  readonly minimum_lifetime?: number;
  /** The assets a job may target; carried so a cache-served menu still constrains the asset
   * the agent commits to. Absent for a template that does not declare it. */
  readonly allowed_assets?: readonly string[];
}

/** One self-selection decision, cached for debuggability / scoring disputes. */
export interface MenuSelectionRecord {
  readonly templateId: string;
  readonly decision: string; // "accept" | "reject" | "needs_more_info"
  readonly confidence: number;
  readonly reason: string;
}

export interface MenuRecord {
  /** Index key: the character name the menu was self-selected for. */
  readonly agent: string;
  readonly templates: readonly MenuTemplate[];
  /** Hash of the source job_templates doc this menu was built from (staleness key). */
  readonly sourceHash: string;
  /** Future signal: the doc's updated_at when available. */
  readonly sourceUpdatedAt?: number;
  /** Future signal: the watch-feed blob pointer. */
  readonly sourceBlobId?: string;
  /** Provenance: the gateway the source was read from. */
  readonly sourceGatewayUrl?: string;
  /** Provenance: the ids of the intake-ready templates the menu was built from. */
  readonly sourceTemplateIds?: readonly string[];
  /** Provenance: the model label that made the self-selection decisions. */
  readonly selectorModel?: string;
  /** Provenance: every self-selection decision (accept/reject/needs_more_info + why). */
  readonly selections?: readonly MenuSelectionRecord[];
  /** When the menu was built/selected (= fetchedAt for this session). */
  readonly createdAt: number;
}

export type WriteMenuResult =
  | { ok: true; blobId: string; indexed?: boolean }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false };

export type ReadMenuResult =
  | { ok: true; menu: MenuRecord }
  | { ok: false; kind: "not_found"; message: string }
  | { ok: false; kind: "blob_unavailable"; blobId: string; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "invalid_menu"; blobId: string; errorName: string; message: string; retryable: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMenuTemplate(value: unknown): value is MenuTemplate {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== "string" || typeof value.category !== "string") return false;
  if (typeof value.evaluator_id !== "string" || typeof value.description !== "string") return false;
  // lifetime is optional now (templates may declare minimum_lifetime and let the user pick).
  if (value.lifetime !== undefined && typeof value.lifetime !== "string") return false;
  if (!isPlainObject(value.params) || !isPlainObject(value.output)) return false;
  return Object.values(value.params).every(
    (p) => isPlainObject(p) && typeof p.ask === "string" && typeof p.type === "string",
  );
}

/** Structural validation of a parsed menu blob. Mirrors isCheckpoint. */
export function isMenuRecord(value: unknown): value is MenuRecord {
  if (!isPlainObject(value)) return false;
  if (typeof value.agent !== "string" || typeof value.sourceHash !== "string") return false;
  if (typeof value.createdAt !== "number") return false;
  if (!Array.isArray(value.templates) || !value.templates.every(isMenuTemplate)) return false;
  return true;
}
