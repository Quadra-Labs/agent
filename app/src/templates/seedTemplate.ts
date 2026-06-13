// seedTemplate.ts — DEV/DEMO helper: seed ONE canonical rich job template into the data
// gateway so the live agent menu is non-empty. PUT /templates is admin-gated (x-quadra-role)
// and the gateway stores the JSON VERBATIM (no schema check), so this seeds the rich
// intake-ready shape (params array + lifetime) even though the data-layer TS type is minimal.
// Gated: needs DATA_GATEWAY_URL reachable + ROLE_TOKEN_ADMIN. Never seeds without the token.
// Run: `npm run seed:template` (after setting DATA_GATEWAY_URL + ROLE_TOKEN_ADMIN in .env).

import { loadAgentConfig } from "../runtime/config.js";

// The canonical intake-ready template (matches the shape intakeTemplate.ts parses).
const TEMPLATE = {
  id: "btc-price-range-24h",
  category: "finance",
  evaluator_id: "btc-price-guess",
  description: "Predict the 24-hour price range for a cryptocurrency",
  params: [
    { key: "asset", ask: "Which cryptocurrency should I predict?", type: "string", required: true },
    { key: "horizon", ask: "Over what time window should I predict the range?", type: "string", required: true },
  ],
  output: { minPrice: "number", maxPrice: "number" },
  lifetime: "24h",
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
  console.log(`seedTemplate: gateway=${config.dataGatewayUrl} template=${TEMPLATE.id}`);

  if (adminToken.length === 0) {
    console.log("SKIPPED: ROLE_TOKEN_ADMIN not set (admin token required to PUT /templates).");
    process.exit(0);
  }

  let res: Response;
  try {
    res = await fetch(`${config.dataGatewayUrl}/templates`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-quadra-role": adminToken },
      body: JSON.stringify(TEMPLATE),
    });
  } catch (err) {
    console.log(`SKIPPED: gateway not reachable (${err instanceof Error ? err.message : "error"}). Set DATA_GATEWAY_URL or start the gateway.`);
    process.exit(0);
  }

  if (res.ok) {
    console.log(
      `PASS: seeded template "${TEMPLATE.id}". The agent will offer it after self-selection ` +
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
