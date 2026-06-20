// types.ts — the shared contract between the tunnel orchestrator (tunnel.ts) and the
// provider modules (cloudflared.ts, ngrok.ts). Kept dependency-free so providers and the
// CLI can import it without a cycle.

export interface TunnelStartOptions {
  /** Local port the agent's inbound HTTP server (serve/chat) binds — the tunnel forwards here. */
  readonly port: number;
  /** Optional sink for the provider's own log lines (prefixed by the orchestrator). */
  readonly onLog?: (line: string) => void;
}

export interface TunnelHandle {
  /**
   * The public HTTPS URL the tunnel assigned, or `undefined` when the provider cannot know
   * it (a Cloudflare named/token tunnel has an externally-configured hostname — the operator
   * supplies AGENT_PUBLIC_URL instead).
   */
  readonly url: string | undefined;
  /** Tear down the tunnel process and its children. Idempotent; safe to call after exit. */
  readonly stop: () => void;
  /** Resolves with the child's exit code (or null) if the tunnel process dies on its own. */
  readonly exited: Promise<number | null>;
}

/**
 * Thrown when a provider's CLI binary is not installed / not on PATH (spawn ENOENT). Carries
 * an install hint the orchestrator prints before exiting non-zero — no raw stack trace.
 */
export class MissingBinaryError extends Error {
  constructor(
    readonly bin: string,
    readonly installHint: string,
  ) {
    super(`${bin} not found on PATH`);
    this.name = "MissingBinaryError";
  }
}
