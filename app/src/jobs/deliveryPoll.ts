// deliveryPoll.ts — the background delivery poller. Once a job's sealed result is
// registered, the agent must tell the intake engine it's done (POST /deliver) and keep
// trying until the on-chain payment confirms — WITHOUT needing the user to keep chatting.
// (The 30-min "didn't deliver -> refund the user" deadline is enforced by the intake
// engine, so a turn-driven deliver that stalls when the user goes silent would lose the
// payment.) This poller runs on a timer off the chat loop, classifying each /deliver
// outcome as released / terminal / pending / transient, and stops on the first decisive
// state or when the delivery window elapses. Calls onDone exactly once. NEVER throws.

import type { Signer } from "@mysten/sui/cryptography";

import { deliverJob } from "../quadra/intakeClient.js";
import type { IntakeSession } from "../quadra/intakeClient.js";

// Poll cadence and bounds. The on-chain payment is observed by intake within a few
// seconds; a 10s cadence keeps post-payment latency low without hammering the validator.
const DEFAULT_INTERVAL_MS = 10_000;
// If the job never becomes active (always "unknown job") past the pending-session TTL
// (intake default 15 min) the user never paid -> give up. A small margin over 15 min.
const DEFAULT_PENDING_GIVEUP_MS = 16 * 60_000;
// Hard cap: worst case the user pays just before the 15-min pending TTL, then the 30-min
// delivery deadline runs from there. Past ~46 min there is nothing left to release.
const DEFAULT_MAX_POLL_MS = 46 * 60_000;

export type DeliveryOutcome =
  // The intake engine released the payment to the agent. Success.
  | { kind: "released" }
  // A terminal /deliver reason: underpaid/orphan ("not releasable"), the validator
  // rejected the output ("invalid result"), or an auth failure. Retrying cannot help.
  | { kind: "rejected"; reason: string }
  // The job never became active before the pending session expired: no payment was seen.
  | { kind: "unpaid" }
  // The 30-min delivery window elapsed without a release (intake will have refunded).
  | { kind: "timeout" };

export interface DeliveryPollOptions {
  readonly baseUrl: string;
  readonly signer: Signer;
  readonly session: IntakeSession;
  /** Submit time, in ms — the deadline bounds are measured from here. */
  readonly startedAtMs: number;
  /** Called exactly once with the terminal outcome. */
  readonly onDone: (outcome: DeliveryOutcome) => void;
  // --- injectables (tests) ---
  readonly intervalMs?: number;
  readonly pendingGiveupMs?: number;
  readonly maxPollMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface DeliveryPollHandle {
  /** Stop polling (e.g. on shutdown). Idempotent; suppresses any pending onDone. */
  readonly cancel: () => void;
}

// One /deliver outcome, reduced to the poller's decision.
type Step = "released" | "pending" | "transient" | { terminal: string };

function classify(d: Awaited<ReturnType<typeof deliverJob>>): Step {
  if (d.ok) {
    if (d.released) return "released";
    const reason = d.reason ?? "";
    const lower = reason.toLowerCase();
    // Underpaid / orphan payment, or a validator rejection: nothing retrying can fix.
    if (lower.includes("not releasable")) return { terminal: reason || "job is not releasable" };
    if (lower.includes("invalid")) return { terminal: reason || "invalid result" };
    // The active job does not exist yet: not paid / not observed on-chain.
    if (lower.includes("unknown job")) return "pending";
    // "job is settling" or anything unrecognized: the job is active, retry shortly.
    return "transient";
  }
  // Transport / validator outage: retry. Auth or an unexpected status is terminal.
  if (d.kind === "validator_unavailable" || d.kind === "network_error") return "transient";
  return { terminal: `${d.kind}: ${d.message}` };
}

/**
 * Start polling POST /deliver in the background until a decisive outcome. Stops on:
 * released, a terminal reason, the pending session expiring with no payment ever seen,
 * or the delivery window elapsing. NEVER throws (deliverJob never throws). Returns a
 * cancel handle.
 */
export function startDeliveryPoll(opts: DeliveryPollOptions): DeliveryPollHandle {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const pendingGiveup = opts.pendingGiveupMs ?? DEFAULT_PENDING_GIVEUP_MS;
  const maxPoll = opts.maxPollMs ?? DEFAULT_MAX_POLL_MS;

  let done = false;
  // Have we ever seen the active job (any non-"unknown job" response)? Distinguishes
  // "user hasn't paid" from "active but momentarily unreleasable".
  let sawActive = false;
  let timer: unknown;

  const finish = (outcome: DeliveryOutcome): void => {
    if (done) return;
    done = true;
    opts.onDone(outcome);
  };

  const tick = async (): Promise<void> => {
    if (done) return;
    if (now() - opts.startedAtMs > maxPoll) {
      finish({ kind: "timeout" });
      return;
    }
    const d = await deliverJob({
      baseUrl: opts.baseUrl,
      signer: opts.signer,
      jobId: opts.session.job_id,
    });
    if (done) return; // cancelled mid-request
    const step = classify(d);
    if (step === "released") {
      finish({ kind: "released" });
      return;
    }
    if (typeof step === "object") {
      finish({ kind: "rejected", reason: step.terminal });
      return;
    }
    if (step === "pending") {
      if (!sawActive && now() - opts.startedAtMs > pendingGiveup) {
        finish({ kind: "unpaid" });
        return;
      }
    } else {
      sawActive = true; // "transient": the active job exists, just can't release yet
    }
    if (!done) timer = setTimer(() => void tick(), interval);
  };

  // First attempt immediately: if the payment already landed, release at once.
  void tick();

  return {
    cancel: (): void => {
      if (done) return;
      done = true;
      clearTimer(timer);
    },
  };
}
