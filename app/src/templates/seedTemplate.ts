// seedTemplate.ts — DEV/DEMO helper: seed ONE canonical rich job template into the data
// gateway so the live agent menu is non-empty. PUT /templates is admin-gated (x-quadra-role)
// and the gateway stores the JSON VERBATIM (no schema check), so this seeds the rich
// intake-ready shape (params array + lifetime) even though the data-layer TS type is minimal.
// Gated: needs DATA_GATEWAY_URL reachable + ROLE_TOKEN_ADMIN. Never seeds without the token.
// Run: `npm run seed:template` (scored finance template) or `npm run seed:template -- --scoreless`
// (the scoreless SEO-article template) after setting DATA_GATEWAY_URL + ROLE_TOKEN_ADMIN in .env.

import { loadAgentConfig } from "../runtime/config.js";

// The canonical intake-ready template (matches the shape intakeTemplate.ts parses + the data
// layer JobTemplate). The user picks the lifetime (>= minimum_lifetime). `evaluator_id` is the
// finance evaluator's category id; "price-range-guess" scores a [minPrice, maxPrice] band
// volatility-scaled by the lifetime (see evaluation-engine scoring/price_range.rs). The gateway
// stores this JSON verbatim.
const TEMPLATE = {
  id: "btc-price-range",
  category: "finance",
  evaluator_id: "price-range-guess",
  description: "Guess the BTC/USD price band at the end of a window you choose.",
  params: [
    { key: "asset", ask: "Which asset? (BTC, ETH, SOL, SUI)", type: "string", required: true },
    { key: "horizon", ask: "Over what window? (at least 1 minute, e.g. 5m)", type: "duration", required: true },
  ],
  output: { minPrice: "number", maxPrice: "number" },
  start_data_template: { start_price: "number" },
  minimum_lifetime: 60000,
  allowed_assets: ["BTC", "ETH", "SOL", "SUI"],
};

// A SCORELESS template: no evaluator, no asset, no lifetime/scoring window. Paid on delivery
// (the SEO article is sealed + stored), never scored. `scoreless: true` is what makes intake
// skip the validator + scheduling and the agent offer it without an asset/lifetime. The scoring
// fields are present-but-empty (the gateway stores JSON verbatim; consumers branch on scoreless).
const SCORELESS_TEMPLATE = {
  id: "seo-article",
  category: "content",
  scoreless: true,
  evaluator_id: "",
  description: "Write an SEO-friendly article on a topic and keywords you provide.",
  params: [
    { key: "topic", ask: "What topic should the article cover?", type: "string", required: true },
    { key: "keywords", ask: "Which keywords should it target? (comma-separated)", type: "string", required: true },
  ],
  output: { article: "string" },
  start_data_template: {},
  minimum_lifetime: 0,
  allowed_assets: [] as string[],
};

function loadDotEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  try {
    loader(".env");
  } catch {
    // No .env -- rely on the ambient environment.
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadAgentConfig();
  const adminToken = (process.env.ROLE_TOKEN_ADMIN ?? "").trim();
  const template = process.argv.includes("--scoreless") ? SCORELESS_TEMPLATE : TEMPLATE;
  console.log(`seedTemplate: gateway=${config.dataGatewayUrl} template=${template.id}`);

  if (adminToken.length === 0) {
    console.log("SKIPPED: ROLE_TOKEN_ADMIN not set (admin token required to PUT /templates).");
    process.exit(0);
  }

  let res: Response;
  try {
    res = await fetch(`${config.dataGatewayUrl}/templates`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-quadra-role": adminToken },
      body: JSON.stringify(template),
    });
  } catch (err) {
    console.log(`SKIPPED: gateway not reachable (${err instanceof Error ? err.message : "error"}). Set DATA_GATEWAY_URL or start the gateway.`);
    process.exit(0);
  }

  if (res.ok) {
    console.log(
      `PASS: seeded template "${template.id}". The agent will offer it after self-selection ` +
        "(re-run the chat to rebuild the menu).",
    );
    process.exit(0);
  }

  const body = await res.text().catch(() => "");
  console.error(`FAILED: gateway responded ${res.status}${body ? `: ${body}` : ""} (check ROLE_TOKEN_ADMIN).`);
  process.exit(1);
}

main().catch((err) => {
  console.error("seedTemplate error:", err);
  process.exit(1);
});
