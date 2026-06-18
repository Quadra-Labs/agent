// runHttpAgent.ts — serve this agent over HTTP so the web can chat with it DIRECTLY (the Quadra
// dashboard's assistant routes a user to an online agent, then the browser talks to it here).
// Exposes GET /ping (liveness, same shape the register flow validates) and POST /chat, which
// drives the same respond() + payment-first job lifecycle the interactive CLI uses, but keyed by
// a conversationId so many users can chat at once. On boot the agent self-publishes its public URL
// to the data gateway so the web can discover + ping it. Background payment/delivery reuse the
// intake socket + delivery poller. Secrets are never printed.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { Signer } from "@mysten/sui/cryptography";

import { loadAgentConfig } from "./config.js";
import { createAgentRuntime, type AgentRuntimeHandle } from "./runtime.js";
import { respond } from "../chat/chat.js";
import { normalizeWalrusSigner } from "./walrusSigner.js";
import { listTurns } from "../chat/chatMemory.js";
import { advanceJobLifecycle, applyJobPaid, type JobState } from "../jobs/jobLifecycle.js";
import { startDeliveryPoll, type DeliveryPollHandle } from "../jobs/deliveryPoll.js";
import { connectIntakeSocket, type IntakeSocketHandle, type JobPaidEvent } from "../quadra/intakeSocket.js";
import { publishAgentEndpoint } from "../quadra/dataGatewayClient.js";
import { resolveMenu } from "../templates/menuOrchestrator.js";
import type { IntakeTemplate } from "../templates/intakeTemplate.js";
import type { AgentCharacter } from "../character/character.js";
import type { ProduceHook } from "../jobs/jobResult.js";
import { errorDetail } from "./runInteractiveAgent.js";

export interface RunHttpAgentOptions {
  readonly character: AgentCharacter;
  /** Optional result producer (e.g. a framework skill); replaces the default LLM producer. */
  readonly produce?: ProduceHook;
}

/** One web conversation: its room (chat memory key) + the payment-first job state. */
interface Conversation {
  readonly roomId: string;
  readonly user: string;
  jobState: JobState;
  deliveryPoll?: DeliveryPollHandle;
}

/** The payment instructions the web needs to pay for a proposed job, or undefined. */
function jobPayload(s: JobState):
  | { session_id: string; job_id: string; agent_wallet: string; cost: number }
  | undefined {
  if (s.phase === "submitted" && s.session && s.paid !== true) {
    return {
      session_id: s.session.session_id,
      job_id: s.session.job_id,
      agent_wallet: s.session.agent_wallet,
      cost: s.session.cost,
    };
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body.length ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export async function runHttpAgent(opts: RunHttpAgentOptions): Promise<void> {
  const { character } = opts;

  const hasModel =
    (process.env.GROQ_API_KEY ?? "").trim().length > 0 ||
    (process.env.OPENAI_API_KEY ?? "").trim().length > 0;
  const hasSigner = (process.env.WALRUS_SIGNER_KEY ?? "").trim().length > 0;
  if (!hasModel || !hasSigner) {
    console.error("HTTP agent requires a model key (GROQ_API_KEY / OPENAI_API_KEY) and WALRUS_SIGNER_KEY.");
    process.exit(1);
  }

  const config = loadAgentConfig();
  console.log(`=== ${character.name} — HTTP agent ===`);
  console.log("Booting runtime (all four plugins live)...");

  let handle: AgentRuntimeHandle;
  try {
    handle = await createAgentRuntime(config, character);
  } catch (err) {
    console.error("Boot failed:");
    console.error(errorDetail(err));
    process.exit(1);
  }

  // The job menu this agent offers (real templates from the gateway, self-selected).
  const menu = await resolveMenu({
    runtime: handle.runtime,
    character,
    dataGatewayUrl: config.dataGatewayUrl,
    selectorModel: config.groqLargeModel,
  });
  const templatesText = menu.text;
  const jobTemplates: readonly IntakeTemplate[] = menu.templates;
  for (const note of menu.notes) console.log(`[menu] ${note}`);

  const signerRes = normalizeWalrusSigner(config.agentSignerKey ?? "");
  const lifecycleSigner: Signer | undefined = signerRes.ok ? signerRes.signer : undefined;
  const lifecycleArmed = jobTemplates.length > 0 && lifecycleSigner !== undefined;
  const agentAddress = lifecycleSigner?.toSuiAddress() ?? null;

  const conversations = new Map<string, Conversation>();
  const paidJobs = new Map<string, number>(); // job_id -> paid_at_ms

  function getConversation(id: string, user: string): Conversation {
    let conv = conversations.get(id);
    if (!conv) {
      conv = { roomId: `http-${character.name}-${id}`, user, jobState: { phase: "idle" } };
      conversations.set(id, conv);
    }
    return conv;
  }

  // Serialize lifecycle advances globally (one agent, low traffic) so a chat turn and a
  // background `job_paid` can never produce/register concurrently.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // Advance one conversation's lifecycle, collecting its notes + starting the background delivery
  // poller on the transition to `delivering`. Returns the notes for the HTTP response.
  async function stepLifecycle(conv: Conversation): Promise<string[]> {
    if (!lifecycleArmed || lifecycleSigner === undefined) return [];
    if (
      conv.jobState.session !== undefined &&
      conv.jobState.paid !== true &&
      paidJobs.has(conv.jobState.session.job_id)
    ) {
      conv.jobState = applyJobPaid(conv.jobState, {
        job_id: conv.jobState.session.job_id,
        paid_at_ms: paidJobs.get(conv.jobState.session.job_id),
      });
    }
    const turns = await listTurns(handle.runtime, conv.roomId);
    const beforePhase = conv.jobState.phase;
    const advanced = await advanceJobLifecycle({
      runtime: handle.runtime,
      turns,
      config,
      signer: lifecycleSigner,
      templates: jobTemplates,
      state: conv.jobState,
      agent: character.name,
      room: conv.roomId,
      ...(opts.produce !== undefined ? { produce: opts.produce } : {}),
    });
    conv.jobState = advanced.state;

    if (
      beforePhase !== "delivering" &&
      conv.jobState.phase === "delivering" &&
      conv.deliveryPoll === undefined &&
      conv.jobState.session !== undefined
    ) {
      const session = conv.jobState.session;
      conv.deliveryPoll = startDeliveryPoll({
        baseUrl: config.intakeUrl,
        signer: lifecycleSigner,
        session,
        startedAtMs: conv.jobState.submittedAtMs ?? Date.now(),
        onDone: () => {
          conv.deliveryPoll = undefined;
          conv.jobState = { phase: "done" };
        },
      });
    }
    return [...advanced.notes];
  }

  // Real-time payment link: on `job_paid`, find the conversation that owns the job and finish it.
  let intakeSocket: IntakeSocketHandle | undefined;
  if (lifecycleArmed && lifecycleSigner !== undefined) {
    intakeSocket = connectIntakeSocket({
      baseUrl: config.intakeSocketUrl,
      signer: lifecycleSigner,
      onStatus: (note) => console.log(`[socket] ${note}`),
      onJobPaid: (event: JobPaidEvent) => {
        if (paidJobs.has(event.job_id)) return;
        paidJobs.set(event.job_id, event.paid_at_ms);
        const conv = [...conversations.values()].find(
          (c) => c.jobState.session?.job_id === event.job_id,
        );
        if (conv) void serialize(() => stepLifecycle(conv));
      },
    });
  }

  // Self-publish this agent's public URL so the web can discover + chat with it.
  if (config.agentPublicUrl && lifecycleSigner !== undefined) {
    const pub = await publishAgentEndpoint({
      baseUrl: config.dataGatewayUrl,
      signer: lifecycleSigner,
      url: config.agentPublicUrl,
    });
    console.log(
      pub.ok
        ? `Published endpoint ${config.agentPublicUrl} to the data gateway.`
        : `(could not publish endpoint: ${pub.message})`,
    );
  } else if (!config.agentPublicUrl) {
    console.warn("(AGENT_PUBLIC_URL not set — the web cannot discover this agent for chat)");
  }

  const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
  const send = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json", ...CORS });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (req.method === "GET" && (path === "/ping" || path === "/health")) {
      send(res, 200, {
        ok: true,
        service: "quadra-agent",
        name: character.name,
        address: agentAddress,
        ready: agentAddress !== null,
        ts: Date.now(),
      });
      return;
    }
    if (req.method === "POST" && path === "/chat") {
      void (async () => {
        let payload: Record<string, unknown>;
        try {
          payload = await readJson(req);
        } catch {
          send(res, 400, { ok: false, error: "invalid JSON" });
          return;
        }
        const message = typeof payload.message === "string" ? payload.message.trim() : "";
        const conversationId =
          typeof payload.conversationId === "string" && payload.conversationId.length > 0
            ? payload.conversationId
            : "default";
        const user = typeof payload.user === "string" && payload.user.length > 0 ? payload.user : conversationId;
        if (message.length === 0) {
          send(res, 400, { ok: false, error: "message is required" });
          return;
        }
        try {
          const result = await serialize(async () => {
            const conv = getConversation(conversationId, user);
            const reply = await respond(handle.runtime, {
              roomId: conv.roomId,
              user: conv.user,
              text: message,
              ...(templatesText !== undefined ? { templatesText } : {}),
              ...(character.systemPrompt !== undefined ? { systemPrompt: character.systemPrompt } : {}),
            });
            const notes = await stepLifecycle(conv);
            return { reply, notes, job: jobPayload(conv.jobState) };
          });
          send(res, 200, { ok: true, ...result });
        } catch (err) {
          console.error(`(chat failed: ${errorDetail(err)})`);
          send(res, 500, { ok: false, error: "chat failed" });
        }
      })();
      return;
    }
    send(res, 404, { ok: false, error: "not_found" });
  });

  server.on("error", (err) => {
    console.error(`HTTP agent server error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
  server.listen(config.agentPort, config.agentHost, () => {
    console.log(`HTTP agent live: http://${config.agentHost}:${config.agentPort}  (GET /ping, POST /chat)`);
  });

  const shutdown = async (): Promise<void> => {
    intakeSocket?.cancel();
    for (const c of conversations.values()) c.deliveryPoll?.cancel();
    server.close();
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
