// Agent smoke (Task 2 verification). Non-interactive; needs a real Groq key in
// demo/.env and a live Walrus testnet. Prints labeled PASS/FAIL per check, then
// `SMOKE2: PASS` or `SMOKE2: FAIL -- <which>`, setting process.exitCode.
//
// Checks, in order:
//   (a) seedTemplates -> loadTemplates round-trips on Walrus (same array).
//   (b) respond to a job-ish message reads like a confirmation question and does
//       NOT leak raw JSON braces or the literal word "template".
//   (c) a short scripted multi-turn yields a non-empty summary mentioning the asset.
//   (d) writeCheckpoint -> readCheckpoint round-trips on Walrus (summary, turns).
//
// LLM assertions are intentionally loose (non-empty / no-leak), never exact text.

import { loadConfig } from "./config.js";
import { createDemoRuntime, type DemoRuntime } from "./runtime.js";
import {
  seedTemplates,
  loadTemplates,
  renderTemplatesForPrompt,
  DEMO_TEMPLATES,
} from "./templates.js";
import { respond } from "./agent.js";
import { writeCheckpoint, readCheckpoint } from "./memwal.js";
import { WalrusHttpError, type WalrusHttpConfig } from "./walrusHttp.js";

function pass(label: string): void {
  console.log(`PASS -- ${label}`);
}

function failLine(label: string, detail?: string): void {
  console.log(`FAIL -- ${label}${detail ? `: ${detail}` : ""}`);
}

function errorDetail(err: unknown): string {
  if (err instanceof WalrusHttpError) {
    const parts = [err.message];
    if (err.status !== undefined) parts.push(`status=${err.status}`);
    parts.push(`url=${err.url}`);
    if (err.body) parts.push(`body=${err.body}`);
    return parts.join(" | ");
  }
  return err instanceof Error ? err.message : String(err);
}

function loadDotEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader(".env");
  } catch {
    // rely on the shell environment if no .env file exists
  }
}

// A leak check matching the agent's hard rule: no raw JSON braces and no literal
// mention of the internal job definition.
function leaksTemplate(text: string): boolean {
  const lower = text.toLowerCase();
  return text.includes("{") || text.includes("}") || lower.includes("template");
}

function fail(which: string): void {
  console.log(`SMOKE2: FAIL -- ${which}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  console.log("=== DEMO AGENT SMOKE ===");
  loadDotEnv();

  const userGroqKey = (process.env.GROQ_API_KEY ?? "").trim();
  if (userGroqKey.length === 0) {
    console.log("FAIL -- requires GROQ_API_KEY in demo/.env");
    fail("no GROQ_API_KEY");
    return;
  }

  const config = loadConfig();
  const walrusCfg: WalrusHttpConfig = {
    publisherUrl: config.walrusPublisherUrl,
    aggregatorUrl: config.walrusAggregatorUrl,
  };

  let demo: DemoRuntime;
  try {
    demo = await createDemoRuntime(config);
    pass("runtime boots");
  } catch (err) {
    failLine("runtime boots", errorDetail(err));
    fail("runtime boot");
    return;
  }

  try {
    // (a) Templates round-trip on Walrus.
    let templatesText: string;
    try {
      const { blobId } = await seedTemplates(walrusCfg, DEMO_TEMPLATES);
      const loaded = await loadTemplates(walrusCfg, blobId);
      const same = JSON.stringify(loaded) === JSON.stringify(DEMO_TEMPLATES);
      if (!same) {
        failLine("(a) templates round-trip", `blobId=${blobId} array mismatch`);
        fail("(a) templates round-trip");
        return;
      }
      templatesText = renderTemplatesForPrompt(loaded);
      console.log(`     templates blobId: ${blobId}`);
      pass("(a) seedTemplates -> loadTemplates round-trips on Walrus");
    } catch (err) {
      failLine("(a) templates round-trip", errorDetail(err));
      fail("(a) templates round-trip");
      return;
    }

    // (b) A job-ish message gets a confirmation-style, non-leaking reply.
    const roomB = `smoke2-b-${Date.now()}`;
    try {
      const reply = await respond(demo.runtime, {
        roomId: roomB,
        userText: "I want a prediction on the price of bitcoin",
        templatesText,
      });
      console.log(`     respond(b): ${reply.replace(/\s+/g, " ").slice(0, 160)}`);
      if (reply.trim().length === 0) {
        failLine("(b) job-ish reply non-empty", "empty");
        fail("(b) job-ish reply");
        return;
      }
      if (leaksTemplate(reply)) {
        failLine("(b) job-ish reply does not leak template", "found JSON braces or 'template'");
        fail("(b) template leak");
        return;
      }
      pass("(b) respond returns a non-empty reply that does not leak the template");
    } catch (err) {
      failLine("(b) job-ish reply", errorDetail(err));
      fail("(b) job-ish reply");
      return;
    }

    // (c) Scripted multi-turn: confirm, give asset + window, expect a summary that
    //     mentions the asset. Reuse room B so the conversation has context.
    try {
      await respond(demo.runtime, {
        roomId: roomB,
        userText: "Yes, that is right.",
        templatesText,
      });
      await respond(demo.runtime, {
        roomId: roomB,
        userText: "The cryptocurrency is Bitcoin.",
        templatesText,
      });
      const summary = await respond(demo.runtime, {
        roomId: roomB,
        userText: "Predict it over the next 5 minutes.",
        templatesText,
      });
      console.log(`     respond(c): ${summary.replace(/\s+/g, " ").slice(0, 200)}`);
      const mentionsAsset = /bitcoin|btc/i.test(summary);
      if (summary.trim().length === 0 || !mentionsAsset) {
        failLine(
          "(c) multi-turn summary mentions asset",
          summary.trim().length === 0 ? "empty" : "no bitcoin/btc mention",
        );
        fail("(c) multi-turn summary");
        return;
      }
      pass("(c) scripted multi-turn yields a summary mentioning the asset");
    } catch (err) {
      failLine("(c) multi-turn summary", errorDetail(err));
      fail("(c) multi-turn summary");
      return;
    }

    // (d) Checkpoint round-trip on Walrus.
    try {
      const { blobId, preview } = await writeCheckpoint(demo.runtime, walrusCfg, roomB);
      const checkpoint = await readCheckpoint(walrusCfg, blobId);
      console.log(`     checkpoint blobId: ${blobId}`);
      console.log(`     checkpoint preview: ${preview}`);
      if (checkpoint.summary.trim().length === 0 || checkpoint.turnCount <= 0) {
        failLine(
          "(d) checkpoint round-trip",
          `summaryLen=${checkpoint.summary.length} turnCount=${checkpoint.turnCount}`,
        );
        fail("(d) checkpoint round-trip");
        return;
      }
      pass("(d) writeCheckpoint -> readCheckpoint round-trips on Walrus");
    } catch (err) {
      failLine("(d) checkpoint round-trip", errorDetail(err));
      fail("(d) checkpoint round-trip");
      return;
    }

    console.log("SMOKE2: PASS");
    process.exitCode = 0;
  } finally {
    await demo.stop();
  }
}

main().catch((err) => {
  console.error("SMOKE2: FAIL -- unexpected error");
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
