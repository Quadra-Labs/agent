// walrusPluginWithSigner.ts — wires a funded testnet signer into the Walrus service at
// boot WITHOUT editing plugin-walrus (the base plugin boots read-only since a Signer
// can't round-trip through string settings). A thin service SHELL whose static start()
// reads WALRUS_SIGNER_KEY from character.settings, normalizes it, and returns a real
// WalrusService via fromConfig — filed under serviceType "walrus" so MemWal resolves it
// unchanged. The signer is OPTIONAL (absent -> read-only) and NEVER logged.

import { Service } from "@elizaos/core";
import type { IAgentRuntime, Plugin } from "@elizaos/core";

import { WalrusService } from "../../plugins/plugin-walrus/src/walrusService.js";
import { walrusPlugin } from "../../plugins/plugin-walrus/src/index.js";
import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { normalizeWalrusSigner } from "./walrusSigner.js";

// A service SHELL (not a subclass — WalrusService has a private constructor): its static
// start() returns a real WalrusService built via fromConfig, filed under "walrus". stop()
// is unreachable for the registered instance but the Service contract requires it.
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
