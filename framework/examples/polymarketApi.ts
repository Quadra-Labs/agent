// polymarketApi.ts — a tiny read-only Polymarket Gamma client shared by the three prediction
// example agents. It is intentionally minimal (the same favorite-picking baseline the agents use)
// and depends only on a structural `getJson` so it works with the framework's bounded ctx.http.
// GOTCHA: Gamma returns `outcomes` / `outcomePrices` / `clobTokenIds` as JSON-ENCODED STRINGS, so
// we JSON.parse the inner string (the evaluator does the same on the Rust side).

/** The slice of the framework's LoopHttp the helper needs (structural, no framework import). */
export interface HttpLike {
  getJson(url: string, init?: unknown): Promise<unknown>;
}

/** A normalized Polymarket market: its outcomes, current implied prices, and the favorite. */
export interface PolyMarket {
  readonly id: string;
  readonly outcomes: readonly string[];
  readonly prices: readonly number[];
  /** Current implied probability of the YES outcome (or outcomes[0]) in [0,1]. */
  readonly yesPrice: number;
  /** The outcome label with the highest current price (the naive favorite). */
  readonly favorite: string;
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const arr: unknown = JSON.parse(value);
    return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

// Gamma single-object endpoints occasionally return a one-element array; unwrap either shape.
function firstObject(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return (value[0] ?? {}) as Record<string, unknown>;
  return (value ?? {}) as Record<string, unknown>;
}

function toMarket(raw: Record<string, unknown>): PolyMarket {
  const outcomes = parseStringArray(raw.outcomes);
  const prices = parseStringArray(raw.outcomePrices).map((p) => Number(p));
  const yesIdx = Math.max(
    0,
    outcomes.findIndex((o) => o.trim().toLowerCase() === "yes"),
  );
  let favIdx = 0;
  for (let i = 1; i < prices.length; i++) {
    if ((prices[i] ?? -1) > (prices[favIdx] ?? -1)) favIdx = i;
  }
  const yesPrice = Number.isFinite(prices[yesIdx]) ? (prices[yesIdx] as number) : 0;
  return {
    id: String(raw.id ?? ""),
    outcomes,
    prices,
    yesPrice,
    favorite: outcomes[favIdx] ?? "",
  };
}

/** Fetch one market by its Gamma id. */
export async function fetchMarket(http: HttpLike, id: string): Promise<PolyMarket> {
  const body = await http.getJson(
    `https://gamma-api.polymarket.com/markets/${encodeURIComponent(id)}`,
  );
  return toMarket(firstObject(body));
}

/** Fetch every market belonging to an event by its Gamma id. */
export async function fetchEventMarkets(http: HttpLike, id: string): Promise<PolyMarket[]> {
  const body = firstObject(
    await http.getJson(`https://gamma-api.polymarket.com/events/${encodeURIComponent(id)}`),
  );
  const markets = Array.isArray(body.markets) ? body.markets : [];
  return markets.map((m) => toMarket((m ?? {}) as Record<string, unknown>));
}
