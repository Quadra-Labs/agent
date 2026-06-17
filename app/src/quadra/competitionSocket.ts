// competitionSocket.ts — the agent's real-time link to the COMPETITION engine. The engine
// pushes a `competition_job` event when a competition the agent enrolled in (via
// join_competition on-chain) has a free job for it. Connection is authenticated with the SAME
// signed-message scheme as the intake socket (intakeSocket.ts), only the domain separator
// differs: we sign the Sui personal message `${ts}.${SOCKET_AUTH_MESSAGE}` and present
// { ts, sig } in the socket.io handshake auth; the engine recovers our wallet and joins us to
// our own room (competition/src/notify.ts is the server side of this contract).
//
// Mirrors intakeSocket.ts discipline: typed surface, NEVER throws out of the listeners, NEVER
// logs the key or signature. Reconnection (re-signing with a fresh ts) is socket.io's built-in
// backoff. The app's own event copy avoids importing competition-engine types (the same
// structural-mirror discipline as plugin-memwal / intakeSocket).

import { io, type Socket } from "socket.io-client";
import type { Signer } from "@mysten/sui/cryptography";

// The fixed domain-separator the agent signs to open a socket. MUST match the competition
// engine's SOCKET_AUTH_MESSAGE (competition/src/notify.ts).
const SOCKET_AUTH_MESSAGE = "quadra-competition/socket";

// The engine's push payload (structural mirror of the engine's CompetitionJobNotice). A free
// job: there is NO cost, NO escrow, NO session. The agent does the work and registers the
// sealed result directly.
export interface CompetitionJobEvent {
  readonly competition_id: string;
  readonly job_id: string;
  /** The data-layer template id (for logging / provenance). */
  readonly template_id: string;
  /** The raw data-layer JobTemplate (parsed into an IntakeTemplate by the job runner). */
  readonly template: Record<string, unknown>;
  /** Pre-collected parameter values for the job (e.g. asset, horizon). */
  readonly params: Record<string, string>;
  /** The job's validity window, e.g. "5m" (the result's `started_at` + lifetime). */
  readonly lifetime: string;
  /** Job clock start (epoch ms); sealed into the result envelope as `started_at`. */
  readonly started_at_ms: number;
  /** Resolution mode: 0 = scoring, 1 = performance (trading). */
  readonly kind: number;
  /** PERFORMANCE mode only: the starting portfolio (asset -> USD units). */
  readonly portfolio?: Record<string, number>;
}

export interface CompetitionSocketOptions {
  /** Socket origin (config.competitionSocketUrl). */
  readonly baseUrl: string;
  /** The agent signer whose address is a registered, enrolled agent on-chain. */
  readonly signer: Signer;
  /** Called for each `competition_job` push. May fire more than once; callers must dedupe. */
  readonly onCompetitionJob: (event: CompetitionJobEvent) => void;
  /** Connection/auth status notes for the user. NEVER carries secrets. */
  readonly onStatus?: (note: string) => void;
  /** Injectable clock (tests). Defaults to Date.now. */
  readonly now?: () => number;
}

export interface CompetitionSocketHandle {
  /** Disconnect and drop listeners. Idempotent. */
  readonly cancel: () => void;
  readonly isConnected: () => boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Structural guard for an inbound push (mirrors intakeSocket's parseJobPaid). A malformed event
// is ignored rather than throwing. `portfolio` is accepted only when it is a number map.
function parseCompetitionJob(raw: unknown): CompetitionJobEvent | undefined {
  if (!isPlainObject(raw)) return undefined;
  const o = raw;
  if (
    typeof o.competition_id !== "string" ||
    typeof o.job_id !== "string" ||
    typeof o.template_id !== "string" ||
    !isPlainObject(o.template) ||
    !isPlainObject(o.params) ||
    typeof o.lifetime !== "string" ||
    typeof o.started_at_ms !== "number" ||
    typeof o.kind !== "number"
  ) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.params)) {
    if (typeof v === "string") params[k] = v;
  }
  let portfolio: Record<string, number> | undefined;
  if (isPlainObject(o.portfolio)) {
    const p: Record<string, number> = {};
    for (const [k, v] of Object.entries(o.portfolio)) {
      if (typeof v === "number" && Number.isFinite(v)) p[k] = v;
    }
    portfolio = p;
  }
  return {
    competition_id: o.competition_id,
    job_id: o.job_id,
    template_id: o.template_id,
    template: o.template,
    params,
    lifetime: o.lifetime,
    started_at_ms: o.started_at_ms,
    kind: o.kind,
    ...(portfolio !== undefined ? { portfolio } : {}),
  };
}

/**
 * Connect to the competition engine's socket and listen for `competition_job`. The auth
 * callback re-runs on every (re)connect, signing a fresh `${ts}.${SOCKET_AUTH_MESSAGE}`. A
 * signing failure rejects the handshake (the server refuses the unsigned connection) and
 * surfaces a status note — never a throw, never the key. Returns a cancel handle. Mirrors
 * connectIntakeSocket exactly.
 */
export function connectCompetitionSocket(opts: CompetitionSocketOptions): CompetitionSocketHandle {
  const now = opts.now ?? Date.now;
  const status = (note: string): void => opts.onStatus?.(note);

  const socket: Socket = io(opts.baseUrl, {
    auth: (cb) => {
      const ts = now();
      opts.signer
        .signPersonalMessage(new TextEncoder().encode(`${ts}.${SOCKET_AUTH_MESSAGE}`))
        .then(({ signature }) => cb({ ts, sig: signature }))
        .catch(() => {
          status("competition socket auth: could not sign the handshake");
          cb({});
        });
    },
    reconnectionDelayMax: 10_000,
  });

  socket.on("connect", () => status("competition socket connected"));
  socket.on("ready", () => status("competition socket ready"));
  socket.on("competition_job", (raw: unknown) => {
    const event = parseCompetitionJob(raw);
    if (event) opts.onCompetitionJob(event);
  });
  socket.on("connect_error", () => status("competition socket connect error; will retry"));
  socket.on("disconnect", () => status("competition socket disconnected; will retry"));

  let cancelled = false;
  return {
    cancel: (): void => {
      if (cancelled) return;
      cancelled = true;
      socket.removeAllListeners();
      socket.disconnect();
    },
    isConnected: (): boolean => socket.connected,
  };
}
