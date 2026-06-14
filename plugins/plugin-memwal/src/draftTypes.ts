// draftTypes.ts — plugin-memwal's in-conversation JOB-DRAFT contract: the agent's working
// "knowledge pool" for one job in flight (chosen template, the params collected so far,
// readiness, and the minted session), cached as a Walrus blob SEPARATE from both session
// Checkpoints and the job-template Menu. Like the Checkpoint and MenuRecord structural mirrors,
// the plugin keeps its OWN copy of the draft shape (it must NOT import app types). A draft is
// per live conversation: keyed by (agent, room), newest wins. Error `kind` names mirror the
// Walrus result unions so a Walrus failure maps straight through.

/** The intake session minted for this draft's job (mirrors the app's IntakeSession). */
export interface JobDraftSession {
  readonly session_id: string;
  readonly job_id: string;
  readonly agent_wallet: string;
  readonly cost: number;
}

export interface JobDraftRecord {
  /** Index key part 1: the character name this draft belongs to. */
  readonly agent: string;
  /** Index key part 2: the live conversation room the draft is being built in. */
  readonly room: string;
  /** The accepted template's real data-layer id, or undefined before acceptance. */
  readonly templateId?: string;
  /** The minted intake session, set once the job is opened. */
  readonly session?: JobDraftSession;
  /** Param name -> collected value, accumulated across turns. */
  readonly collected: Record<string, string>;
  /** The required param names (snapshot) so readiness needs no template at read time. */
  readonly requiredParams: readonly string[];
  /** Every required param present + valid at write time. */
  readonly ready: boolean;
  /** Lifecycle phase mirror, so a reader can see where the job stands. */
  readonly phase: "idle" | "submitted" | "delivering" | "done";
  /** A job_paid push (or status probe) has confirmed on-chain payment. */
  readonly paid: boolean;
  /** When this draft revision was written. */
  readonly createdAt: number;
}

export type WriteDraftResult =
  | { ok: true; blobId: string; indexed?: boolean }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false };

export type ReadDraftResult =
  | { ok: true; draft: JobDraftRecord }
  | { ok: false; kind: "not_found"; message: string }
  | { ok: false; kind: "blob_unavailable"; blobId: string; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "invalid_draft"; blobId: string; errorName: string; message: string; retryable: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((v) => typeof v === "string");
}

function isDraftSession(value: unknown): value is JobDraftSession {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.session_id === "string" &&
    typeof value.job_id === "string" &&
    typeof value.agent_wallet === "string" &&
    typeof value.cost === "number"
  );
}

/** Structural validation of a parsed job-draft blob. Mirrors isMenuRecord / isCheckpoint. */
export function isJobDraftRecord(value: unknown): value is JobDraftRecord {
  if (!isPlainObject(value)) return false;
  if (typeof value.agent !== "string" || typeof value.room !== "string") return false;
  if (typeof value.ready !== "boolean" || typeof value.paid !== "boolean") return false;
  if (typeof value.phase !== "string") return false;
  if (typeof value.createdAt !== "number") return false;
  if (!isStringRecord(value.collected)) return false;
  if (!Array.isArray(value.requiredParams) || !value.requiredParams.every((p) => typeof p === "string")) {
    return false;
  }
  if (value.templateId !== undefined && typeof value.templateId !== "string") return false;
  if (value.session !== undefined && !isDraftSession(value.session)) return false;
  return true;
}
