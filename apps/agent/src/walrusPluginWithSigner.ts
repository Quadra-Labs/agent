// walrusPluginWithSigner.ts — A3 wrapper that wires a funded testnet SIGNER into
// the Walrus service at boot, WITHOUT modifying plugin-walrus.
//
// plugin-walrus's own WalrusService.start() deliberately does NOT load a signer
// from settings (a Signer cannot round-trip through string settings, so the base
// plugin boots read-only). A3's Walrus DECISION is the SDK path with a funded
// signer, so this app needs store() to be possible in Task 2. We achieve that by
// registering a thin SUBCLASS whose start() reads WALRUS_SIGNER_KEY from
// character.settings, normalizes it into a Signer, and builds the service via the
// base class's fromConfig(). The class keeps serviceType "walrus", so MemWal
// resolves it exactly as before (dependency direction MemWal -> Walrus preserved).
//
// Hard rules honored:
//   - plugin-walrus is NOT edited; we only compose its exported class + plugin.
//   - The signer secret is OPTIONAL: absent/blank/unparseable -> the service still
//     BOOTS read-only (store() returns config_error later). Resolving the service
//     never requires the key.
//   - The signer secret is NEVER logged (only key-free reason labels are warned).

import { Service } from "@elizaos/core";
import type { IAgentRuntime, Plugin } from "@elizaos/core";

import { WalrusService } from "../../../plugins/plugin-walrus/src/walrusService.js";
import { walrusPlugin } from "../../../plugins/plugin-walrus/src/index.js";
import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { normalizeWalrusSigner } from "./walrusSigner.js";

// A thin service SHELL registered in place of the base WalrusService class. It is
// NOT a subclass: WalrusService keeps a PRIVATE constructor (construction goes
// through fromConfig only), so it cannot be extended. The framework stores
// whatever this shell's static start() RETURNS under serviceType "walrus", and
// start() returns a real WalrusService built via fromConfig with a settings-
// sourced signer. So getService("walrus") yields a genuine WalrusService (working
// store/read) — MemWal resolves it exactly as before. The shell's own serviceType
// must match "walrus" so the framework files the instance under that key.
//
// stop() here is unreachable for the registered instance (the framework calls
// stop() on the RETURNED WalrusService, not on this shell), but the abstract
// Service contract requires it.
class WalrusSignerBootstrap extends Service {
  static override serviceType = WalrusService.serviceType;

  override capabilityDescription =
    "Bootstraps the Walrus service with a settings-sourced signer.";

  static override async start(runtime: IAgentRuntime): Promise<WalrusService> {
    const network = (runtime.getSetting("WALRUS_NETWORK") as string | null) ?? "testnet";
    const suiRpcUrl =
      (runtime.getSetting("SUI_RPC_URL") as string | null) ??
      (network === "testnet" ? getJsonRpcFullnodeUrl("testnet") : "");

    const epochsSetting = runtime.getSetting("WALRUS_EPOCHS");
    const epochs =
      epochsSetting === null || epochsSetting === undefined ? undefined : Number(epochsSetting);

    // The secret is read as a STRING from settings and normalized here. Absent or
    // unparseable -> boot read-only (no throw). The secret is never logged.
    const rawSigner = runtime.getSetting("WALRUS_SIGNER_KEY") as string | null;
    const signer = resolveSigner(runtime, rawSigner);

    // deletable:true is REQUIRED for the Walrus SDK store path on testnet
    // (walrus-sdk-gotchas); without it writeBlob fails at the epoch boundary.
    // epochs defaults to 3 in WalrusService.normalize and is rejected below 3, so
    // the testnet floor is enforced there too.
    return WalrusService.fromConfig(
      {
        suiRpcUrl,
        network: network as "testnet",
        epochs,
        deletable: true,
        signer,
      },
      runtime,
    );
  }

  override async stop(): Promise<void> {
    // The registered instance is the returned WalrusService; this shell's stop()
    // is never invoked. Present only to satisfy the abstract Service contract.
  }
}

// Turn the optional settings string into a Signer (or undefined for read-only
// boot). A present-but-unparseable secret is downgraded to read-only with a
// key-free warning so the runtime still comes up.
function resolveSigner(
  runtime: IAgentRuntime,
  raw: string | null,
): import("@mysten/sui/cryptography").Signer | undefined {
  if (raw === null || raw.trim().length === 0) return undefined;
  const result = normalizeWalrusSigner(raw);
  if (result.ok) return result.signer;
  const note = `walrus: WALRUS_SIGNER_KEY present but unparseable; booting read-only (${result.reason})`;
  if (runtime.logger?.warn) {
    runtime.logger.warn(note);
  } else if (typeof console !== "undefined") {
    console.warn(note);
  }
  return undefined;
}

// The plugin object the app registers: identical to plugin-walrus except the
// service class is swapped for the signer-aware bootstrap shell. Same name, same
// actions/providers, same "walrus" serviceType.
export const walrusPluginWithSigner: Plugin = {
  ...walrusPlugin,
  services: [WalrusSignerBootstrap as unknown as typeof Service],
};

export default walrusPluginWithSigner;
