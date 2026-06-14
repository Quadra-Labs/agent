// intakeSocket.ts — the agent's real-time link to the intake engine. The engine pushes a
// `job_paid` event the moment it observes the user's on-chain payment, so the agent can start
// the job at once instead of polling. Connection is authenticated with the SAME signed-message
// scheme as the HTTP clients (quadraSignedRequest.ts / intake auth.ts): we sign the Sui
// personal message `${ts}.${SOCKET_AUTH_MESSAGE}` and present { ts, sig } in the socket.io
// handshake auth; the engine recovers our wallet and joins us to our own room (intake-engine
// src/notify.ts is the server side of this contract).
//
// Mirrors intakeClient.ts discipline: typed surface, NEVER throws out of the listeners, NEVER
// logs the key or signature. Reconnection (and re-signing with a fresh ts) is socket.io's
// built-in backoff; each reconnect re-runs the auth callback. The app's own JobPaidEvent copy
// avoids importing intake-engine types (same structural-mirror discipline as plugin-memwal).

import { io, type Socket } from "socket.io-client";
import type { Signer } from "@mysten/sui/cryptography";

// The fixed domain-separator the agent signs to open a socket. MUST match intake-engine's
// SOCKET_AUTH_MESSAGE (src/notify.ts).
const SOCKET_AUTH_MESSAGE = "quadra-intake/socket";

// The engine's push payload (structural mirror of intake-engine's JobPaidNotice).
export interface JobPaidEvent {
  readonly session_id: string;
  readonly job_id: string;
  readonly escrow_id: string;
  readonly cost: number;
  readonly paid_at_ms: number;
  readonly deadline_ms: number;
}

export interface IntakeSocketOptions {
  /** Socket origin (config.intakeSocketUrl). */
  readonly baseUrl: string;
  /** The agent signer whose address is a registered agent on-chain. */
  readonly signer: Signer;
  /** Called for each `job_paid` push. May fire more than once; callers must dedupe. */
  readonly onJobPaid: (event: JobPaidEvent) => void;
  /** Connection/auth status notes for the user. NEVER carries secrets. */
  readonly onStatus?: (note: string) => void;
  /** Injectable clock (tests). Defaults to Date.now. */
  readonly now?: () => number;
}

export interface IntakeSocketHandle {
  /** Disconnect and drop listeners. Idempotent. */
  readonly cancel: () => void;
  readonly isConnected: () => boolean;
}

// Structural guard for an inbound push (mirrors asSession). A malformed event is ignored.
function parseJobPaid(raw: unknown): JobPaidEvent | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.session_id === "string" &&
    typeof o.job_id === "string" &&
    typeof o.escrow_id === "string" &&
    typeof o.cost === "number" &&
    typeof o.paid_at_ms === "number" &&
    typeof o.deadline_ms === "number"
  ) {
    return {
      session_id: o.session_id,
      job_id: o.job_id,
      escrow_id: o.escrow_id,
      cost: o.cost,
      paid_at_ms: o.paid_at_ms,
      deadline_ms: o.deadline_ms,
    };
  }
  return undefined;
}

/**
 * Connect to the intake engine's socket and listen for `job_paid`. The auth callback re-runs on
 * every (re)connect, signing a fresh `${ts}.${SOCKET_AUTH_MESSAGE}`. A signing failure rejects
 * the handshake (the server refuses the unsigned connection) and surfaces a status note — never
 * a throw, never the key. Returns a cancel handle.
 */
export function connectIntakeSocket(opts: IntakeSocketOptions): IntakeSocketHandle {
  const now = opts.now ?? Date.now;
  const status = (note: string): void => opts.onStatus?.(note);

  const socket: Socket = io(opts.baseUrl, {
    // The auth callback form lets us re-sign with a fresh ts on each (re)connect. The `cb`
    // type is inferred from socket.io-client's option type (do not annotate it).
    auth: (cb) => {
      const ts = now();
      opts.signer
        .signPersonalMessage(new TextEncoder().encode(`${ts}.${SOCKET_AUTH_MESSAGE}`))
        .then(({ signature }) => cb({ ts, sig: signature }))
        .catch(() => {
          // Hand the server nothing -> it rejects -> connect_error fires. Never log the error.
          status("socket auth: could not sign the handshake");
          cb({});
        });
    },
    // Bounded reconnection backoff; socket.io retries indefinitely by default which is fine
    // for a long-lived chat session.
    reconnectionDelayMax: 10_000,
  });

  socket.on("connect", () => status("intake socket connected"));
  // The engine emits `ready` once the handshake is accepted; purely informational.
  socket.on("ready", () => status("intake socket ready"));
  socket.on("job_paid", (raw: unknown) => {
    const event = parseJobPaid(raw);
    if (event) opts.onJobPaid(event);
  });
  // Fixed-label notes only — never echo the raw error object (it can carry transport detail).
  socket.on("connect_error", () => status("intake socket connect error; will retry"));
  socket.on("disconnect", () => status("intake socket disconnected; will retry"));

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
