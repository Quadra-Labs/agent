// memwalService.ts — long-lived MemWal service: round-trips a Checkpoint through Walrus
// under a pluggable encrypt/decrypt seam. MemWal COMPOSES Walrus (MemWal -> Walrus,
// never the reverse); the WalrusService is resolved via getService, never reconstructed.
// The seam is plain bytes-in/bytes-out: empty = plain/demo mode, a present pair = prod
// (whatever supplies it, e.g. Seal, owns that concern; MemWal stays Seal-agnostic).
// readCheckpoint's parser requires the full Checkpoint shape (index-key + numeric fields).

import { Service } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";

import { CheckpointIndex } from "./checkpointIndex.js";
import type { CheckpointIndexRecord } from "./checkpointIndex.js";
import { MenuIndex } from "./menuIndex.js";
import { DraftIndex } from "./draftIndex.js";
import type {
  Checkpoint,
  MemwalSeam,
  ReadCheckpointResult,
  WriteCheckpointResult,
} from "./types.js";
import { isMenuRecord } from "./menuTypes.js";
import type { MenuRecord, ReadMenuResult, WriteMenuResult } from "./menuTypes.js";
import { isJobDraftRecord } from "./draftTypes.js";
import type { JobDraftRecord, ReadDraftResult, WriteDraftResult } from "./draftTypes.js";

// The Walrus serviceType MemWal resolves (mirrors WalrusService.serviceType).
const WALRUS_SERVICE_TYPE = "walrus";

// --- Walrus contract MemWal consumes (structural mirror) ---------------------
// MemWal depends on the Walrus runtime CONTRACT, not on the plugin-walrus build
// artifact: plugin-walrus ships no dist and its public `exports` surface does not
// re-export WalrusService or these result unions, so MemWal models exactly the
// slice it calls. Task 1 deliberately reused Walrus's `kind` names, so these
// shapes mirror plugin-walrus/src/types.ts (WalrusStoreResult / WalrusReadResult)
// 1:1. The reverse direction is forbidden: plugin-walrus must never import MemWal.
type WalrusStoreLikeResult =
  | { ok: true; blobId: string; blobObjectId?: string; sizeBytes: number }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false };

type WalrusReadLikeResult =
  | { ok: true; bytes: Uint8Array; blobId: string }
  | { ok: false; kind: "blob_unavailable"; blobId: string; errorName: string; message: string; retryable: false }
  | { ok: false; kind: "network_error"; errorName: string; message: string; retryable: true }
  | { ok: false; kind: "config_error"; errorName: string; message: string; retryable: false };

// The structural slice of WalrusService MemWal actually calls. Resolving against
// this (rather than the full class) keeps the dependency to the two methods we
// use and lets tests inject a tiny fake without reconstructing the real service.
type WalrusLike = {
  store(bytes: Uint8Array): Promise<WalrusStoreLikeResult>;
  read(blobId: string): Promise<WalrusReadLikeResult>;
};

// Normalized service config. Only the seam lives here — the Walrus client is NOT
// held (it is resolved per call from the runtime so MemWal always uses the one
// long-lived instance the runtime owns, never a copy).
type NormalizedMemwalConfig = {
  readonly seam: MemwalSeam;
};

// The EMPTY seam: plain mode. Frozen so the default can never be mutated into a
// shared prod seam by accident.
const EMPTY_SEAM: MemwalSeam = Object.freeze({});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function errorNameOf(err: unknown): string {
  if (err instanceof Error) return err.name;
  return "Error";
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Structural validation of a parsed checkpoint. Lifts the demo's summary/roomId
// string guards and EXTENDS them to the full Checkpoint contract: the index-key
// strings (user/agent/session) and the numeric fields (createdAt/turnCount).
function isCheckpoint(value: unknown): value is Checkpoint {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.roomId === "string" &&
    typeof o.summary === "string" &&
    typeof o.user === "string" &&
    typeof o.agent === "string" &&
    typeof o.session === "string" &&
    typeof o.createdAt === "number" &&
    typeof o.turnCount === "number"
  );
}

export class MemwalService extends Service {
  static override serviceType = "memwal";

  override capabilityDescription =
    "Round-trips a session checkpoint through Walrus, applying a pluggable encrypt/decrypt seam.";

  private readonly cfg: NormalizedMemwalConfig;

  // The SQLite-backed checkpoint index, a PRIVATE collaborator the service owns.
  // Built lazily from this.runtime the first time it is needed (the runtime is
  // only optional in the constructor signature; an index op always has one). There
  // is NO public accessor — callers reach the index only through the read methods
  // below, and only the service's own ok:true write path records into it (mirrors
  // walrus's recordHandle: no action->service write path).
  private indexCache: CheckpointIndex | undefined;

  // The SQLite-backed MENU index, a separate private collaborator (distinct table +
  // namespace) so the job-template menu cache never collides with checkpoints.
  private menuIndexCache: MenuIndex | undefined;

  // The SQLite-backed JOB-DRAFT index, a third private collaborator (distinct table +
  // namespace) so the in-conversation job draft never collides with checkpoints or menus.
  private draftIndexCache: DraftIndex | undefined;

  // PRIVATE constructor: construction goes through start()/fromConfig() only. A
  // function seam cannot round-trip through runtime string settings, so the seam
  // is injected via fromConfig (same reasoning as walrus's signer). NO network I/O.
  private constructor(runtime: IAgentRuntime | undefined, cfg: NormalizedMemwalConfig) {
    super(runtime);
    this.cfg = cfg;
  }

  // Build the service from an explicit seam. Used by tests / plugin wiring that
  // inject the seam directly (a function seam cannot survive runtime string
  // settings). NO network I/O.
  static fromConfig(seam: MemwalSeam | undefined, runtime?: IAgentRuntime): MemwalService {
    return new MemwalService(runtime, { seam: seam ?? EMPTY_SEAM });
  }

  // ElizaOS lifecycle entry point. NO seam is loadable from string settings, so a
  // service started this way defaults to the EMPTY seam (plain mode); the real
  // (Seal-backed) seam is injected out-of-band via fromConfig. NO network I/O.
  static override async start(runtime: IAgentRuntime): Promise<MemwalService> {
    return MemwalService.fromConfig(EMPTY_SEAM, runtime);
  }

  override async stop(): Promise<void> {
    // No network connections to tear down; this service holds only the seam and
    // resolves the Walrus client per call. Present to satisfy the abstract
    // Service contract.
  }

  // Resolve the one long-lived Walrus service from the runtime. Returns undefined
  // if absent (callers map that to a typed config_error RESULT, not a throw). The
  // resolved value is consumed through the WalrusLike structural slice — the two
  // methods (store/read) MemWal actually calls.
  private resolveWalrus(): WalrusLike | undefined {
    const runtime = this.runtime as IAgentRuntime | undefined;
    // getService<T> constrains T extends Service; resolve at the base Service type
    // then narrow to the WalrusLike structural slice (mirrors how plugin-walrus's
    // status provider casts the resolved service to the shape it consumes).
    const service = runtime?.getService(WALRUS_SERVICE_TYPE);
    return (service as WalrusLike | null | undefined) ?? undefined;
  }

  // Resolve (lazily build) the checkpoint index. Returns undefined only if the
  // service has no runtime (index ops need the runtime's local DB). The instance
  // is cached so repeated ops share one collaborator; persistence lives entirely
  // in the runtime DB, so a FRESH service against the same DB sees prior records.
  private resolveIndex(): CheckpointIndex | undefined {
    const runtime = this.runtime as IAgentRuntime | undefined;
    if (runtime === undefined) return undefined;
    if (this.indexCache === undefined) {
      this.indexCache = new CheckpointIndex(runtime);
    }
    return this.indexCache;
  }

  // Resolve (lazily build) the MENU index. Same lifecycle as the checkpoint index but a
  // distinct collaborator (its own table + namespace), so menu and checkpoint records never
  // share a bucket. Returns undefined only if the service has no runtime.
  private resolveMenuIndex(): MenuIndex | undefined {
    const runtime = this.runtime as IAgentRuntime | undefined;
    if (runtime === undefined) return undefined;
    if (this.menuIndexCache === undefined) {
      this.menuIndexCache = new MenuIndex(runtime);
    }
    return this.menuIndexCache;
  }

  // Resolve (lazily build) the JOB-DRAFT index. Same lifecycle as the menu index but a
  // distinct collaborator (its own table + namespace). Returns undefined only if the service
  // has no runtime.
  private resolveDraftIndex(): DraftIndex | undefined {
    const runtime = this.runtime as IAgentRuntime | undefined;
    if (runtime === undefined) return undefined;
    if (this.draftIndexCache === undefined) {
      this.draftIndexCache = new DraftIndex(runtime);
    }
    return this.draftIndexCache;
  }

  // --- Index read methods (public; no public mutator) ------------------------
  // Callers RESOLVE checkpoints through these; they never write the index. The
  // only write path is the service's own ok:true writeCheckpoint leg below.

  // listCheckpoints: blobIds for a (user, agent) pair, NEWEST-first. Unknown pair
  // -> EMPTY array (no throw). Returns [] when the service has no runtime/index.
  async listCheckpoints(
    user: string,
    agent: string,
    session?: string,
  ): Promise<readonly string[]> {
    const index = this.resolveIndex();
    if (index === undefined) return [];
    return index.listBlobIds(user, agent, session);
  }

  // listCheckpointRecords: full index records for a (user, agent) pair, newest-
  // first (blobId + the (user, agent, session) triple + ordering/preview meta).
  // Richer than listCheckpoints; does NOT touch the locked types.ts unions.
  async listCheckpointRecords(
    user: string,
    agent: string,
    session?: string,
  ): Promise<readonly CheckpointIndexRecord[]> {
    const index = this.resolveIndex();
    if (index === undefined) return [];
    return index.list(user, agent, session);
  }

  // latest: the single newest blobId for a (user, agent) pair, or undefined.
  async latest(
    user: string,
    agent: string,
    session?: string,
  ): Promise<string | undefined> {
    const index = this.resolveIndex();
    if (index === undefined) return undefined;
    return index.latest(user, agent, session);
  }

  // Record one index entry for an already-durable blob. Returns true when the
  // (user, agent[, session]) -> blobId entry landed, false when index.record threw.
  // A throw here would otherwise SILENTLY orphan a durable blob (blob on Walrus,
  // mapping lost), so the failure is made VISIBLE: a warn-level log naming the
  // blobId and the (user, agent, session) whose entry failed, plus the error (ids
  // and error text only — no secrets). The store already succeeded; this never
  // turns a write into a failure, it only reports the index outcome via `indexed`.
  private async recordIndexEntry(
    index: CheckpointIndex,
    checkpoint: Checkpoint,
    blobId: string,
  ): Promise<boolean> {
    try {
      await index.record({
        user: checkpoint.user,
        agent: checkpoint.agent,
        session: checkpoint.session,
        blobId,
        summary: checkpoint.summary,
      });
      return true;
    } catch (err) {
      const detail = {
        blobId,
        user: checkpoint.user,
        agent: checkpoint.agent,
        session: checkpoint.session,
        errorName: errorNameOf(err),
        message: messageOf(err),
      };
      const note =
        `memwal: checkpoint blob ${blobId} is durable on Walrus but its index entry ` +
        `for (user=${checkpoint.user}, agent=${checkpoint.agent}, session=${checkpoint.session}) ` +
        `failed to record; recall-by-index may not find it: ${detail.message}`;
      const logger = (this.runtime as IAgentRuntime | undefined)?.logger;
      if (logger?.warn) {
        logger.warn(detail, note);
      } else if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn(note);
      }
      return false;
    }
  }

  // --- Operations ------------------------------------------------------------

  // writeCheckpoint: JSON-encode -> (optional encrypt seam) -> walrus.store.
  // Maps WalrusStoreResult onto WriteCheckpointResult; the network_error /
  // config_error kinds were reused in Task 1 so they pass straight through.
  async writeCheckpoint(checkpoint: Checkpoint): Promise<WriteCheckpointResult> {
    const walrus = this.resolveWalrus();
    if (walrus === undefined) {
      return {
        ok: false,
        kind: "config_error",
        errorName: "MemwalConfigError",
        message: "walrus service is not registered",
        retryable: false,
      };
    }

    const plain = encoder.encode(JSON.stringify(checkpoint));
    const bytes = this.cfg.seam.encrypt ? await this.cfg.seam.encrypt(plain) : plain;

    const result = await walrus.store(bytes);
    if (result.ok) {
      // Self-record into the SQLite-backed index on the ok:true path so the
      // (user, agent[, session]) -> blobId mapping survives a restart. This is the
      // ONLY index write path; no action can mutate the index directly. Best-
      // effort: the blob is already durable on Walrus, so an index write hiccup
      // must not turn a successful store into a failure result. The `indexed`
      // signal on the ok:true result reports whether the index entry landed so a
      // caller can tell when recall-by-index may not find this otherwise-durable
      // blob (an empty catch here would SILENTLY orphan it).
      const index = this.resolveIndex();
      const indexed =
        index !== undefined
          ? await this.recordIndexEntry(index, checkpoint, result.blobId)
          : false;
      return { ok: true, blobId: result.blobId, indexed };
    }
    if (result.kind === "network_error") {
      return {
        ok: false,
        kind: "network_error",
        errorName: result.errorName,
        message: result.message,
        retryable: true,
      };
    }
    // config_error (the only remaining store failure kind).
    return {
      ok: false,
      kind: "config_error",
      errorName: result.errorName,
      message: result.message,
      retryable: false,
    };
  }

  // readCheckpoint: walrus.read -> (optional decrypt seam) -> JSON-parse +
  // validate. Walrus failure kinds (blob_unavailable / network_error /
  // config_error) pass straight through; a blob that reads back but is malformed
  // is the MemWal-specific invalid_checkpoint kind — NEVER a throw.
  async readCheckpoint(blobId: string): Promise<ReadCheckpointResult> {
    const walrus = this.resolveWalrus();
    if (walrus === undefined) {
      return {
        ok: false,
        kind: "config_error",
        errorName: "MemwalConfigError",
        message: "walrus service is not registered",
        retryable: false,
      };
    }

    const result = await walrus.read(blobId);
    if (!result.ok) {
      if (result.kind === "blob_unavailable") {
        return {
          ok: false,
          kind: "blob_unavailable",
          blobId,
          errorName: result.errorName,
          message: result.message,
          retryable: false,
        };
      }
      if (result.kind === "network_error") {
        return {
          ok: false,
          kind: "network_error",
          errorName: result.errorName,
          message: result.message,
          retryable: true,
        };
      }
      // config_error (the only remaining read failure kind).
      return {
        ok: false,
        kind: "config_error",
        errorName: result.errorName,
        message: result.message,
        retryable: false,
      };
    }

    // Bytes read back: apply the decrypt seam if present, then parse + validate.
    // Any decrypt / parse / validation failure is a malformed blob -> typed
    // invalid_checkpoint result, NOT a throw.
    try {
      const bytes = this.cfg.seam.decrypt
        ? await this.cfg.seam.decrypt(result.bytes)
        : result.bytes;
      const parsed: unknown = JSON.parse(decoder.decode(bytes));
      if (!isCheckpoint(parsed)) {
        return {
          ok: false,
          kind: "invalid_checkpoint",
          blobId,
          errorName: "InvalidCheckpointError",
          message: `Checkpoint blob ${blobId} is missing or has malformed required fields.`,
          retryable: false,
        };
      }
      const checkpoint: Checkpoint = {
        roomId: parsed.roomId,
        createdAt: parsed.createdAt,
        turnCount: parsed.turnCount,
        summary: parsed.summary,
        user: parsed.user,
        agent: parsed.agent,
        session: parsed.session,
      };
      return { ok: true, checkpoint };
    } catch (err) {
      return {
        ok: false,
        kind: "invalid_checkpoint",
        blobId,
        errorName: errorNameOf(err),
        message: messageOf(err),
        retryable: false,
      };
    }
  }

  // --- Menu operations (additive; the checkpoint path above is untouched) ----
  // The agent's self-selected job-template menu is cached here so the conversation layer can
  // read it without re-deriving every turn. MemWal is NOT the source of truth — the record
  // carries sourceHash so a caller compares it to a fresh fetch and rebuilds when stale.

  // writeMenu: JSON-encode -> (optional encrypt seam) -> walrus.store -> self-record into the
  // MENU index. Mirrors writeCheckpoint's best-effort indexing: the blob is durable on
  // ok:true regardless of whether the index entry landed (`indexed` reports it). NEVER throws.
  async writeMenu(menu: MenuRecord): Promise<WriteMenuResult> {
    const walrus = this.resolveWalrus();
    if (walrus === undefined) {
      return {
        ok: false,
        kind: "config_error",
        errorName: "MemwalConfigError",
        message: "walrus service is not registered",
        retryable: false,
      };
    }

    const plain = encoder.encode(JSON.stringify(menu));
    const bytes = this.cfg.seam.encrypt ? await this.cfg.seam.encrypt(plain) : plain;

    const result = await walrus.store(bytes);
    if (result.ok) {
      const index = this.resolveMenuIndex();
      let indexed = false;
      if (index !== undefined) {
        try {
          await index.record({ agent: menu.agent, blobId: result.blobId, sourceHash: menu.sourceHash });
          indexed = true;
        } catch (err) {
          const note = `memwal: menu blob ${result.blobId} is durable but its index entry for agent ${menu.agent} failed to record: ${messageOf(err)}`;
          const logger = (this.runtime as IAgentRuntime | undefined)?.logger;
          if (logger?.warn) logger.warn({ blobId: result.blobId, agent: menu.agent }, note);
          else if (typeof console !== "undefined" && typeof console.warn === "function") console.warn(note);
        }
      }
      return { ok: true, blobId: result.blobId, indexed };
    }
    if (result.kind === "network_error") {
      return { ok: false, kind: "network_error", errorName: result.errorName, message: result.message, retryable: true };
    }
    return { ok: false, kind: "config_error", errorName: result.errorName, message: result.message, retryable: false };
  }

  // latestMenuMeta: the newest menu's blobId + sourceHash for an agent WITHOUT a blob read —
  // the cheap staleness check (compare sourceHash to a fresh fetch before reading the blob).
  async latestMenuMeta(
    agent: string,
  ): Promise<{ blobId: string; sourceHash: string; createdAt: number } | undefined> {
    const index = this.resolveMenuIndex();
    if (index === undefined) return undefined;
    const record = await index.latestRecord(agent);
    if (record === undefined) return undefined;
    return { blobId: record.blobId, sourceHash: record.sourceHash, createdAt: record.createdAt };
  }

  // readLatestMenu: resolve the newest menu blobId for an agent, read it back through Walrus +
  // the optional decrypt seam, and validate. not_found when no entry; invalid_menu for a blob
  // that read back malformed; Walrus failure kinds pass through. NEVER throws.
  async readLatestMenu(agent: string): Promise<ReadMenuResult> {
    const walrus = this.resolveWalrus();
    if (walrus === undefined) {
      return { ok: false, kind: "config_error", errorName: "MemwalConfigError", message: "walrus service is not registered", retryable: false };
    }
    const index = this.resolveMenuIndex();
    const blobId = index !== undefined ? await index.latest(agent) : undefined;
    if (blobId === undefined) {
      return { ok: false, kind: "not_found", message: `no cached menu for agent ${agent}` };
    }

    const result = await walrus.read(blobId);
    if (!result.ok) {
      if (result.kind === "blob_unavailable") {
        return { ok: false, kind: "blob_unavailable", blobId, errorName: result.errorName, message: result.message, retryable: false };
      }
      if (result.kind === "network_error") {
        return { ok: false, kind: "network_error", errorName: result.errorName, message: result.message, retryable: true };
      }
      return { ok: false, kind: "config_error", errorName: result.errorName, message: result.message, retryable: false };
    }

    try {
      const bytes = this.cfg.seam.decrypt ? await this.cfg.seam.decrypt(result.bytes) : result.bytes;
      const parsed: unknown = JSON.parse(decoder.decode(bytes));
      if (!isMenuRecord(parsed)) {
        return { ok: false, kind: "invalid_menu", blobId, errorName: "InvalidMenuError", message: `Menu blob ${blobId} is missing or has malformed fields.`, retryable: false };
      }
      return { ok: true, menu: parsed };
    } catch (err) {
      return { ok: false, kind: "invalid_menu", blobId, errorName: errorNameOf(err), message: messageOf(err), retryable: false };
    }
  }

  // --- Job-draft operations (additive; checkpoint + menu paths above are untouched) -------
  // The agent's in-conversation "knowledge pool" for one job in flight: the chosen template,
  // the params collected so far, readiness, and the minted session. The readiness check reads
  // this back (across turns / restarts) rather than re-deriving from the transcript alone.

  // writeDraft: JSON-encode -> (optional encrypt seam) -> walrus.store -> self-record into the
  // DRAFT index. Mirrors writeMenu's best-effort indexing: the blob is durable on ok:true
  // regardless of whether the index entry landed (`indexed` reports it). NEVER throws.
  async writeDraft(draft: JobDraftRecord): Promise<WriteDraftResult> {
    const walrus = this.resolveWalrus();
    if (walrus === undefined) {
      return {
        ok: false,
        kind: "config_error",
        errorName: "MemwalConfigError",
        message: "walrus service is not registered",
        retryable: false,
      };
    }

    const plain = encoder.encode(JSON.stringify(draft));
    const bytes = this.cfg.seam.encrypt ? await this.cfg.seam.encrypt(plain) : plain;

    const result = await walrus.store(bytes);
    if (result.ok) {
      const index = this.resolveDraftIndex();
      let indexed = false;
      if (index !== undefined) {
        try {
          await index.record({ agent: draft.agent, room: draft.room, blobId: result.blobId });
          indexed = true;
        } catch (err) {
          const note = `memwal: draft blob ${result.blobId} is durable but its index entry for (agent=${draft.agent}, room=${draft.room}) failed to record: ${messageOf(err)}`;
          const logger = (this.runtime as IAgentRuntime | undefined)?.logger;
          if (logger?.warn) logger.warn({ blobId: result.blobId, agent: draft.agent, room: draft.room }, note);
          else if (typeof console !== "undefined" && typeof console.warn === "function") console.warn(note);
        }
      }
      return { ok: true, blobId: result.blobId, indexed };
    }
    if (result.kind === "network_error") {
      return { ok: false, kind: "network_error", errorName: result.errorName, message: result.message, retryable: true };
    }
    return { ok: false, kind: "config_error", errorName: result.errorName, message: result.message, retryable: false };
  }

  // readLatestDraft: resolve the newest draft blobId for an (agent, room) pair, read it back
  // through Walrus + the optional decrypt seam, and validate. not_found when no entry;
  // invalid_draft for a blob that read back malformed; Walrus failure kinds pass through.
  // NEVER throws.
  async readLatestDraft(agent: string, room: string): Promise<ReadDraftResult> {
    const walrus = this.resolveWalrus();
    if (walrus === undefined) {
      return { ok: false, kind: "config_error", errorName: "MemwalConfigError", message: "walrus service is not registered", retryable: false };
    }
    const index = this.resolveDraftIndex();
    const blobId = index !== undefined ? await index.latest(agent, room) : undefined;
    if (blobId === undefined) {
      return { ok: false, kind: "not_found", message: `no job draft for (agent ${agent}, room ${room})` };
    }

    const result = await walrus.read(blobId);
    if (!result.ok) {
      if (result.kind === "blob_unavailable") {
        return { ok: false, kind: "blob_unavailable", blobId, errorName: result.errorName, message: result.message, retryable: false };
      }
      if (result.kind === "network_error") {
        return { ok: false, kind: "network_error", errorName: result.errorName, message: result.message, retryable: true };
      }
      return { ok: false, kind: "config_error", errorName: result.errorName, message: result.message, retryable: false };
    }

    try {
      const bytes = this.cfg.seam.decrypt ? await this.cfg.seam.decrypt(result.bytes) : result.bytes;
      const parsed: unknown = JSON.parse(decoder.decode(bytes));
      if (!isJobDraftRecord(parsed)) {
        return { ok: false, kind: "invalid_draft", blobId, errorName: "InvalidDraftError", message: `Draft blob ${blobId} is missing or has malformed fields.`, retryable: false };
      }
      return { ok: true, draft: parsed };
    } catch (err) {
      return { ok: false, kind: "invalid_draft", blobId, errorName: errorNameOf(err), message: messageOf(err), retryable: false };
    }
  }
}
