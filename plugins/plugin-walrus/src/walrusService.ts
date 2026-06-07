// walrusService.ts — long-lived Walrus client service (Phase 1, Task 2).
//
// Owns exactly ONE SuiJsonRpcClient + ONE WalrusClient, built inside the static
// `start` lifecycle with NO network I/O, and reused across every store/read call.
// Stores and reads OPAQUE BYTES ONLY. No Seal / MemWal / job / template / Intake
// / signing-handshake concerns appear here.
//
// Ported call shapes (READ-ONLY references):
//   phase0/spike/p1_walrus_roundtrip.mjs     — writeBlob/readBlob happy path
//   phase0/spike/p1_5_walrus_hardening.mjs   — bad-id failure classification
//   phase0/spike-evidence/P1_5-walrus-hardening.md — BlobNotCertifiedError mapping

import { Service } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { WalrusClient } from "@mysten/walrus";

import { WalrusConfigError } from "./errors.js";
import { classifyWalrusError } from "./errorClassification.js";
import { recordHandle } from "./recentHandles.js";
import type {
  NormalizedWalrusServiceConfig,
  StoredBlobHandle,
  WalrusReadResult,
  WalrusServiceConfigInput,
  WalrusStoreResult,
} from "./types.js";

// Upper bound on the in-memory recently-stored handle ring. In-memory only —
// NOT a durable index (durability would lean toward MemWal, which is Phase 3).
const MAX_RECENT_HANDLES = 20;

export class WalrusService extends Service {
  static override serviceType = "walrus";

  override capabilityDescription =
    "Stores and reads erasure-coded opaque blobs on Walrus.";

  // The single long-lived clients. Built once in start(), reused for every call.
  private readonly suiClient: SuiJsonRpcClient;
  private readonly walrusClient: WalrusClient;
  private readonly cfg: NormalizedWalrusServiceConfig;

  // Bounded, newest-first ring of handles from recent successful store() calls.
  // The FIELD is reassignable but the ARRAY is never mutated in place — every
  // update goes through recordHandle, which returns a fresh readonly array. The
  // service self-records here (see store()); there is NO public mutator and thus
  // NO action->service write path.
  private recent: readonly StoredBlobHandle[] = [];

  private constructor(runtime: IAgentRuntime | undefined, cfg: NormalizedWalrusServiceConfig) {
    super(runtime);
    this.cfg = cfg;
    // SuiJsonRpcClient (NOT SuiGraphQLClient — 5000B query limit breaks Walrus).
    // It satisfies ClientWithCoreApi at runtime (.core + .cache) but the @mysten/
    // walrus types do not declare that; the documented cast bridges it. Never a
    // switch to GraphQL.
    this.suiClient = new SuiJsonRpcClient({ url: cfg.suiRpcUrl, network: cfg.network });
    this.walrusClient = new WalrusClient({
      network: cfg.network,
      suiClient: this.suiClient as unknown as ClientWithCoreApi,
    });
  }

  // Static config validation (NO network I/O) + normalization. Throws a typed
  // WalrusConfigError on bad/missing static config. Shared by start() and
  // fromConfig().
  private static normalize(input: WalrusServiceConfigInput): NormalizedWalrusServiceConfig {
    if (typeof input.suiRpcUrl !== "string" || input.suiRpcUrl.trim().length === 0) {
      throw new WalrusConfigError("suiRpcUrl is required and must be a non-empty string");
    }
    try {
      // eslint-disable-next-line no-new
      new URL(input.suiRpcUrl);
    } catch {
      throw new WalrusConfigError(`suiRpcUrl is not a valid URL: ${input.suiRpcUrl}`);
    }
    if (input.network !== "testnet") {
      throw new WalrusConfigError(`network must be "testnet" (got: ${String(input.network)})`);
    }

    // epochs defaults to 3 and is rejected below 3: epochs=1 via the public HTTP
    // publisher expired at the epoch boundary in P0b, and 3 is the proven safe
    // minimum (walrus-sdk-gotchas). This is the documented Walrus testnet floor.
    const epochs = input.epochs ?? 3;
    if (!Number.isInteger(epochs) || epochs < 3) {
      throw new WalrusConfigError(
        `epochs must be an integer >= 3 (Walrus testnet minimum; got: ${String(input.epochs)})`,
      );
    }

    const deletable = input.deletable ?? false;

    return {
      suiRpcUrl: input.suiRpcUrl,
      network: input.network,
      signer: input.signer, // optional, never logged
      epochs,
      deletable,
    };
  }

  // Build the service from an explicit input config. Used by start() and by
  // tests / plugin wiring that inject a Signer object directly (a Signer cannot
  // round-trip through runtime string settings). NO network I/O.
  static fromConfig(
    input: WalrusServiceConfigInput,
    runtime?: IAgentRuntime,
  ): WalrusService {
    const cfg = WalrusService.normalize(input);
    return new WalrusService(runtime, cfg);
  }

  // ElizaOS lifecycle entry point. Reads static config from runtime settings,
  // validates it (throwing WalrusConfigError on bad input, NO network I/O), and
  // constructs the long-lived clients. A signer is NOT loaded here from settings
  // (it is injected out-of-band, e.g. via fromConfig, and never logged); a
  // service started without a signer is a valid read-only service.
  static override async start(runtime: IAgentRuntime): Promise<WalrusService> {
    const network = (runtime.getSetting("WALRUS_NETWORK") as string | null) ?? "testnet";
    const suiRpcUrl =
      (runtime.getSetting("SUI_RPC_URL") as string | null) ??
      (network === "testnet" ? getJsonRpcFullnodeUrl("testnet") : "");

    const epochsSetting = runtime.getSetting("WALRUS_EPOCHS");
    const epochs =
      epochsSetting === null || epochsSetting === undefined
        ? undefined
        : Number(epochsSetting);

    const deletableSetting = runtime.getSetting("WALRUS_DELETABLE");
    const deletable =
      deletableSetting === null || deletableSetting === undefined
        ? undefined
        : deletableSetting === true || deletableSetting === "true";

    return WalrusService.fromConfig(
      {
        suiRpcUrl,
        network: network as "testnet",
        epochs,
        deletable,
      },
      runtime,
    );
  }

  override async stop(): Promise<void> {
    // No network connections to tear down; the clients are stateless HTTP/RPC.
    // Present to satisfy the abstract Service contract.
  }

  // --- Operations ------------------------------------------------------------

  // store() requires a signer. Without one it returns a config_error RESULT
  // ("signer required for store"), NOT a throw — the service was validly started
  // read-only. epochs/deletable are always passed explicitly from normalized
  // config (deletable has no SDK default; epochs defaults to 3 and never < 3).
  async store(bytes: Uint8Array): Promise<WalrusStoreResult> {
    const signer = this.cfg.signer;
    if (signer === undefined) {
      return {
        ok: false,
        kind: "config_error",
        errorName: "WalrusConfigError",
        message: "signer required for store",
        retryable: false,
      };
    }

    try {
      const { blobId, blobObject } = await this.walrusClient.writeBlob({
        blob: bytes,
        epochs: this.cfg.epochs,
        deletable: this.cfg.deletable,
        signer,
      });
      // Self-record the handle ONLY on success. Read/assign this.recent AFTER the
      // await resolves (no pre-await snapshot) so concurrent stores each fold into
      // the latest ring rather than overwriting each other's update.
      const handle: StoredBlobHandle = {
        blobId,
        blobObjectId: blobObject?.id,
        sizeBytes: bytes.length,
        storedAtMs: Date.now(),
      };
      this.recent = recordHandle(this.recent, handle, MAX_RECENT_HANDLES);
      return {
        ok: true,
        blobId,
        blobObjectId: blobObject?.id,
        sizeBytes: bytes.length,
      };
    } catch (err) {
      // Classifiable network failure -> typed result; everything else
      // (blob_unavailable is not a store outcome; unclassifiable) -> throw loudly.
      const classified = classifyWalrusError(err);
      if (classified.kind === "network_error") {
        return {
          ok: false,
          kind: "network_error",
          errorName: classified.errorName,
          message: classified.message,
          retryable: true,
        };
      }
      throw err;
    }
  }

  // read() needs no signer. A non-existent / non-certified blob is a typed
  // blob_unavailable result — NEVER null, NEVER a throw-through.
  async read(blobId: string): Promise<WalrusReadResult> {
    try {
      const bytes = await this.walrusClient.readBlob({ blobId });
      return { ok: true, bytes, blobId };
    } catch (err) {
      const classified = classifyWalrusError(err);
      if (classified.kind === "blob_unavailable") {
        return {
          ok: false,
          kind: "blob_unavailable",
          blobId,
          errorName: classified.errorName,
          message: classified.message,
          retryable: false,
        };
      }
      if (classified.kind === "network_error") {
        return {
          ok: false,
          kind: "network_error",
          errorName: classified.errorName,
          message: classified.message,
          retryable: true,
        };
      }
      // Unclassifiable failure: throw at the service layer (fail tests loudly).
      // Never coerce an unknown shape into network_error.
      throw err;
    }
  }

  // Newest-first snapshot of the in-memory recently-stored handles, read by the
  // walrusStatus provider. Returns per-handle COPIES (never the internal array
  // nor its elements): every field is a primitive, so a shallow spread fully
  // isolates each handle even if a caller casts away readonly. In-memory only —
  // no persistence, no durability.
  recentHandles(): readonly StoredBlobHandle[] {
    return this.recent.map((h) => ({ ...h }));
  }
}
