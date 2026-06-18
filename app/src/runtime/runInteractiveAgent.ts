// runInteractiveAgent.ts — the reusable interactive agent harness extracted from cli.ts: boot
// the runtime (all four plugins), resolve the job menu, recall a prior checkpoint, then run the
// payment-first REPL with the intake socket + background delivery poller. Parameterized by the
// character + user + an OPTIONAL result `produce` hook. cli.ts is a thin wrapper over this; the
// framework price-range example runner calls it too, passing a Pyth-skill producer. Refuses to
// start without GROQ_API_KEY + WALRUS_SIGNER_KEY so /close is always a live checkpoint. Secrets
// are never printed.

import { createInterface } from "node:readline";

import type { Signer } from "@mysten/sui/cryptography";

import { loadAgentConfig } from "./config.js";
import { startHealthServer, type HealthServerHandle } from "./healthServer.js";
import { createAgentRuntime, type AgentRuntimeHandle } from "./runtime.js";
import { respond } from "../chat/chat.js";
import { closeSession } from "../session/closeSession.js";
import { recallCheckpoint } from "../session/recallCheckpoint.js";
import { normalizeWalrusSigner } from "./walrusSigner.js";
import { listTurns } from "../chat/chatMemory.js";
import { advanceJobLifecycle, applyJobPaid, type JobState } from "../jobs/jobLifecycle.js";
import { startDeliveryPoll, type DeliveryPollHandle, type DeliveryOutcome } from "../jobs/deliveryPoll.js";
import type { IntakeSession } from "../quadra/intakeClient.js";
import {
  connectIntakeSocket,
  type IntakeSocketHandle,
  type JobPaidEvent,
} from "../quadra/intakeSocket.js";
import {
  connectCompetitionSocket,
  type CompetitionSocketHandle,
  type CompetitionJobEvent,
} from "../quadra/competitionSocket.js";
import { runCompetitionJob } from "../jobs/competitionJob.js";
import { joinCompetition } from "../quadra/joinCompetition.js";
import type { AgentCharacter } from "../character/character.js";
import { resolveMenu } from "../templates/menuOrchestrator.js";
import type { IntakeTemplate } from "../templates/intakeTemplate.js";
import type { ProduceHook } from "../jobs/jobResult.js";

export interface RunInteractiveAgentOptions {
  /** The agent identity (drives chat + the (user, agent) checkpoint key + menu pre-filter). */
  readonly character: AgentCharacter;
  /** The user identity (checkpoint index key). */
  readonly user: string;
  /** Optional result producer (e.g. the framework Pyth price-range skill). When set it replaces
   * the default LLM producer for the job result. */
  readonly produce?: ProduceHook;
}

export function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

const HELP = [
  "Commands:",
  "  /close            checkpoint this session to Walrus (live) and clear recalled context",
  "  /resume           re-recall the latest checkpoint for this (user, agent)",
  "  /join <id>        enrol in a competition on-chain (then receive free jobs)",
  "  /help             show this help",
  "  /exit             quit (does NOT auto-checkpoint; run /close first to persist)",
].join("\n");

// Narrow the free-form config.walrusNetwork to the Sui client's network union.
function narrowNetwork(n: string): "testnet" | "mainnet" | "devnet" | "localnet" {
  return n === "mainnet" || n === "devnet" || n === "localnet" ? n : "testnet";
}

// Render a background delivery-poll outcome into a user-facing line.
function describeDeliveryOutcome(outcome: DeliveryOutcome, session: IntakeSession): string {
  switch (outcome.kind) {
    case "released":
      return `Payment released for job ${session.job_id}. Job complete.`;
    case "rejected":
      return `Delivery could not be released: ${outcome.reason}.`;
    case "unpaid":
      return `No payment was received for session ${session.session_id}; the job session expired.`;
    case "timeout":
      return "The delivery window elapsed without release; the intake engine will refund the user.";
  }
}

/**
 * Boot and run one interactive agent session to completion (the process exits from within on
 * /exit or a fatal boot error). NEVER returns normally in practice; the REPL drives it. Reuses
 * the exact payment-first flow cli.ts had — only the character/user/produce are now injected.
 */
export async function runInteractiveAgent(opts: RunInteractiveAgentOptions): Promise<void> {
  const { character, user } = opts;

  const hasGroq = (process.env.GROQ_API_KEY ?? "").trim().length > 0;
  const hasOpenai = (process.env.OPENAI_API_KEY ?? "").trim().length > 0;
  const hasModel = hasGroq || hasOpenai;
  const hasSigner = (process.env.WALRUS_SIGNER_KEY ?? "").trim().length > 0;
  if (!hasModel || !hasSigner) {
    console.error("Interactive chat requires full setup (presence only; secrets never read aloud):");
    console.error(`  GROQ_API_KEY / OPENAI_API_KEY: ${hasModel ? "present" : "MISSING"}  (a text-model key, needed to chat)`);
    console.error(
      `  WALRUS_SIGNER_KEY:             ${hasSigner ? "present" : "MISSING"}  (funded testnet key; needed so /close writes a live checkpoint)`,
    );
    console.error("Set a model key + the signer in app/.env, then re-run.");
    process.exit(1);
  }

  const config = loadAgentConfig();

  console.log(`=== ${character.name} — interactive chat ===`);
  console.log(`user="${user}"  agent="${character.name}"`);
  console.log("Booting runtime (all four plugins live)...");

  let handle: AgentRuntimeHandle;
  try {
    handle = await createAgentRuntime(config, character);
  } catch (err) {
    console.error("Boot failed:");
    console.error(errorDetail(err));
    process.exit(1);
  }

  // A single conversational room for this session. Distinct per launch so the within-session
  // history starts clean; /resume injects prior context via summary.
  const runToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const roomId = `cli-${character.name}-${user}-${runToken}`;

  // Read the REAL job templates from the data gateway, self-select the ones this agent offers,
  // and cache the menu in MemWal. resolveMenu NEVER throws and degrades cleanly.
  let templatesText: string | undefined;
  let jobTemplates: readonly IntakeTemplate[] = [];
  const menu = await resolveMenu({
    runtime: handle.runtime,
    character,
    dataGatewayUrl: config.dataGatewayUrl,
    selectorModel: config.groqLargeModel,
  });
  templatesText = menu.text;
  jobTemplates = menu.templates;
  for (const note of menu.notes) console.log(`[menu] ${note}`);
  if (jobTemplates.length > 0) {
    console.log(`Job menu ready (${menu.source}); the agent can offer ${jobTemplates.length} job type(s).`);
  } else {
    console.log("No offerable jobs for this agent right now; continuing as plain chat.");
  }

  // Recall any prior checkpoint for this (user, agent) and seed the resumed summary.
  let resumedSummary: string | undefined;
  const initialRecall = await recallCheckpoint(handle.runtime, { user, agent: character.name });
  if (initialRecall.kind === "recalled") {
    resumedSummary = initialRecall.summary;
    console.log(`Recalled a prior session: ${initialRecall.summary}`);
  } else if (initialRecall.kind === "error") {
    console.warn(`(recall failed: ${initialRecall.errorKind} — starting fresh)`);
  } else {
    console.log("No prior checkpoint for this user/agent — starting fresh.");
  }

  // Arm the automatic job lifecycle: resolve the agent signer (AGENT_SECRET_KEY ??
  // WALRUS_SIGNER_KEY) used to authenticate to the intake engine + data gateway.
  const signerRes = normalizeWalrusSigner(config.agentSignerKey ?? "");
  const lifecycleSigner: Signer | undefined = signerRes.ok ? signerRes.signer : undefined;
  if (jobTemplates.length > 0) {
    if (lifecycleSigner !== undefined) {
      console.log(
        `Job lifecycle armed: I'll open a job with the intake engine at ${config.intakeUrl} when I accept one.`,
      );
    } else {
      console.warn(
        `(job lifecycle disabled: agent signer unparseable — ${signerRes.ok ? "ok" : signerRes.reason})`,
      );
    }
  }
  const lifecycleArmed = jobTemplates.length > 0 && lifecycleSigner !== undefined;
  let jobState: JobState = { phase: "idle" };
  let deliveryPoll: DeliveryPollHandle | undefined;
  let intakeSocket: IntakeSocketHandle | undefined;
  let competitionSocket: CompetitionSocketHandle | undefined;

  // Inbound liveness endpoint so an external validator can confirm this agent is up
  // and reports the wallet being registered. Independent of the job lifecycle.
  const healthServer: HealthServerHandle | undefined = startHealthServer({
    port: config.agentPort,
    host: config.agentHost,
    name: character.name,
    signer: lifecycleSigner,
  });
  if (healthServer !== undefined) {
    console.log(`Liveness endpoint live: GET http://${config.agentHost}:${config.agentPort}/ping`);
  }

  console.log("");
  console.log(HELP);
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = (): void => rl.setPrompt("you> ");

  let stopping = false;
  const shutdown = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    deliveryPoll?.cancel();
    intakeSocket?.cancel();
    competitionSocket?.cancel();
    await healthServer?.close();
    rl.close();
    await handle.stop();
    process.exit(code);
  };

  const doClose = async (): Promise<void> => {
    console.log("Checkpointing session to Walrus...");
    const outcome = await closeSession(handle.runtime, {
      roomId,
      user,
      agent: character.name,
      session: runToken,
    });
    switch (outcome.kind) {
      case "saved":
        console.log(`Saved: blob ${outcome.blobId} (durable + indexed). Preview: ${outcome.preview}`);
        resumedSummary = undefined;
        break;
      case "degraded":
        console.log(`Degraded: blob ${outcome.blobId} durable but NOT indexed — /resume may miss it.`);
        break;
      case "empty":
        console.log("Nothing to checkpoint (no turns yet).");
        break;
      case "error":
        console.log(`Checkpoint failed (${outcome.errorKind}): ${outcome.message}`);
        break;
    }
  };

  const doResume = async (): Promise<void> => {
    const recall = await recallCheckpoint(handle.runtime, { user, agent: character.name });
    if (recall.kind === "recalled") {
      resumedSummary = recall.summary;
      console.log(`Recalled: ${recall.summary}`);
    } else if (recall.kind === "error") {
      console.log(`Recall failed (${recall.errorKind}): ${recall.message}`);
    } else {
      console.log("No prior checkpoint to recall for this user/agent.");
    }
  };

  // Job ids the socket confirmed as paid -> their on-chain paid_at_ms. Applied INSIDE the
  // serialized lifecycle step (below) so a concurrent chat-turn step that recomputes jobState
  // can never clobber the `paid` flag.
  const paidJobs = new Map<string, number>();

  // One lifecycle advance: read the transcript, advance the (payment-first) state machine, print
  // its notes, and start the background delivery poller on the transition to delivering. Shared
  // by the chat-turn path and the socket `job_paid` path. Threads the optional produce hook.
  const lifecycleStepOnce = async (): Promise<void> => {
    if (!lifecycleArmed || lifecycleSigner === undefined) return;
    try {
      // Re-apply any confirmed payment for the current job here (inside the serialized step) so
      // it survives a racing chat-turn step that would otherwise overwrite jobState back to unpaid.
      if (
        jobState.session !== undefined &&
        jobState.paid !== true &&
        paidJobs.has(jobState.session.job_id)
      ) {
        jobState = applyJobPaid(jobState, {
          job_id: jobState.session.job_id,
          paid_at_ms: paidJobs.get(jobState.session.job_id),
        });
      }
      const turns = await listTurns(handle.runtime, roomId);
      const beforePhase = jobState.phase;
      const advanced = await advanceJobLifecycle({
        runtime: handle.runtime,
        turns,
        config,
        signer: lifecycleSigner,
        templates: jobTemplates,
        state: jobState,
        agent: character.name,
        room: roomId,
        ...(opts.produce !== undefined ? { produce: opts.produce } : {}),
      });
      jobState = advanced.state;
      for (const note of advanced.notes) console.log(`[job] ${note}`);

      if (
        beforePhase !== "delivering" &&
        jobState.phase === "delivering" &&
        deliveryPoll === undefined &&
        jobState.session !== undefined
      ) {
        const session = jobState.session;
        console.log(
          "[job] Result is in. I'll deliver to the intake engine now — no need to keep chatting.",
        );
        deliveryPoll = startDeliveryPoll({
          baseUrl: config.intakeUrl,
          signer: lifecycleSigner,
          session,
          startedAtMs: jobState.submittedAtMs ?? Date.now(),
          onDone: (outcome) => {
            deliveryPoll = undefined;
            jobState = { phase: "done" };
            console.log(`[job] ${describeDeliveryOutcome(outcome, session)}`);
          },
        });
      }
    } catch (err) {
      console.error(`(job lifecycle error: ${errorDetail(err)})`);
    }
  };

  // Serialize lifecycle advances so a chat turn and a socket `job_paid` can never produce /
  // register concurrently. Concurrent requests coalesce into a single re-run.
  let lifecycleBusy = false;
  let lifecycleAgain = false;
  const runLifecycleStep = async (): Promise<void> => {
    if (lifecycleBusy) {
      lifecycleAgain = true;
      return;
    }
    lifecycleBusy = true;
    try {
      do {
        lifecycleAgain = false;
        await lifecycleStepOnce();
      } while (lifecycleAgain);
    } finally {
      lifecycleBusy = false;
    }
  };

  // A `job_paid` push confirms payment: record it (deduped) and advance off the chat loop, so the
  // job finishes even if the user has gone silent after paying. The flag is applied inside the
  // serialized lifecycle step (see paidJobs above) to avoid the chat-turn race.
  const handleJobPaid = async (event: JobPaidEvent): Promise<void> => {
    if (paidJobs.has(event.job_id)) return; // already handled this payment
    paidJobs.set(event.job_id, event.paid_at_ms);
    console.log(`[job] Payment confirmed for job ${event.job_id}. Finishing the job...`);
    await runLifecycleStep();
  };

  // Connect the real-time link to the intake engine, gated by the same condition that arms the
  // lifecycle (templates offered + a usable signer).
  if (lifecycleArmed && lifecycleSigner !== undefined) {
    intakeSocket = connectIntakeSocket({
      baseUrl: config.intakeSocketUrl,
      signer: lifecycleSigner,
      onStatus: (note) => console.log(`[socket] ${note}`),
      onJobPaid: (event) => void handleJobPaid(event),
    });
  }

  // Competition mode: accept FREE competition jobs over a SEPARATE socket, independent of the
  // paid lifecycle. This path NEVER touches jobState, so the payment-first flow is unchanged.
  const handledCompetitionJobs = new Set<string>();
  const handleCompetitionJob = async (event: CompetitionJobEvent): Promise<void> => {
    if (handledCompetitionJobs.has(event.job_id)) return; // already working/done this job
    handledCompetitionJobs.add(event.job_id);
    if (lifecycleSigner === undefined) return;
    console.log(
      `[competition] Free job ${event.job_id} (competition ${event.competition_id}, kind ${event.kind}); working...`,
    );
    const outcome = await runCompetitionJob({
      runtime: handle.runtime,
      config,
      signer: lifecycleSigner,
      event,
      ...(opts.produce !== undefined ? { produce: opts.produce } : {}),
    });
    if (outcome.ok) {
      console.log(
        `[competition] Delivered ${outcome.jobId} (blob ${outcome.blobId}); the engine scores it at lifetime end.`,
      );
    } else {
      console.log(`[competition] Job ${event.job_id} not delivered (${outcome.kind}): ${outcome.message}`);
      // Allow a re-push to retry only when the failure is retryable.
      if (outcome.retryable !== false) handledCompetitionJobs.delete(event.job_id);
    }
  };

  const doJoin = async (competitionId: string): Promise<void> => {
    if (lifecycleSigner === undefined) {
      console.log("Cannot join: no usable agent signer (set AGENT_SECRET_KEY / WALRUS_SIGNER_KEY).");
      return;
    }
    const res = await joinCompetition({
      signer: lifecycleSigner,
      network: narrowNetwork(config.walrusNetwork),
      quadraPackageId: config.quadraPackageId ?? "",
      agentRegistryId: config.agentRegistryId ?? "",
      competitionId,
    });
    if (res.ok) console.log(`[competition] Joined ${competitionId} (tx ${res.digest}).`);
    else console.log(`[competition] Join failed (${res.kind}): ${res.message}`);
  };

  if (config.competitionEnabled && lifecycleSigner !== undefined) {
    competitionSocket = connectCompetitionSocket({
      baseUrl: config.competitionSocketUrl,
      signer: lifecycleSigner,
      onStatus: (note) => console.log(`[competition] ${note}`),
      onCompetitionJob: (event) => void handleCompetitionJob(event),
    });
    console.log(`Competition mode on: listening for free jobs at ${config.competitionSocketUrl}.`);
    if (config.competitionId !== undefined) {
      console.log(`Auto-joining competition ${config.competitionId}...`);
      await doJoin(config.competitionId);
    }
  } else if (config.competitionEnabled) {
    console.warn("(competition mode requested but disabled: agent signer unparseable)");
  }

  prompt();
  rl.prompt();

  rl.on("line", async (raw) => {
    const text = raw.trim();
    if (text.length === 0) {
      rl.prompt();
      return;
    }

    if (text === "/exit" || text === "/quit") {
      await shutdown(0);
      return;
    }
    if (text === "/help") {
      console.log(HELP);
      rl.prompt();
      return;
    }
    if (text === "/close") {
      try {
        await doClose();
      } catch (err) {
        console.error(`/close error: ${errorDetail(err)}`);
      }
      rl.prompt();
      return;
    }
    if (text === "/resume") {
      try {
        await doResume();
      } catch (err) {
        console.error(`/resume error: ${errorDetail(err)}`);
      }
      rl.prompt();
      return;
    }
    if (text === "/join" || text.startsWith("/join ")) {
      const id = text.slice("/join".length).trim();
      if (id.length === 0) {
        console.log("Usage: /join <competitionId>");
      } else {
        try {
          await doJoin(id);
        } catch (err) {
          console.error(`/join error: ${errorDetail(err)}`);
        }
      }
      rl.prompt();
      return;
    }

    try {
      const reply = await respond(handle.runtime, {
        roomId,
        user,
        text,
        resumedSummary,
        templatesText,
        systemPrompt: character.systemPrompt,
      });
      resumedSummary = undefined;
      console.log(`${character.name}> ${reply}`);
      await runLifecycleStep();
    } catch (err) {
      console.error(`(reply failed: ${errorDetail(err)})`);
    }
    rl.prompt();
  });

  rl.on("SIGINT", () => {
    console.log("\n(use /exit to quit; /close first to persist this session)");
    rl.prompt();
  });
}
