// cryptoSignals.ts — read-only market signals for the crypto/commodities prediction agent.
// It is the multi-signal layer the agent reasons over, kept separate from the shared
// polymarketApi.ts so the example agents stay decoupled. Three signals, all structural
// (only a `getJson` is required, so it works with the framework's bounded ctx.http):
//
//   1. the live Polymarket market (current YES probability + the YES CLOB token id + text),
//   2. the recent YES-token price trend on the CLOB (short-term drift + volatility),
//   3. the underlying asset's spot price (crypto only, via Coinbase) as a cross-check.
//
// GOTCHA: Gamma returns `outcomes`/`outcomePrices`/`clobTokenIds` as JSON-ENCODED STRINGS,
// so the inner string is JSON.parsed (the same shape the Rust evaluator decodes).

/** The slice of the framework's LoopHttp this module needs (structural, no framework import). */
export interface HttpLike {
  getJson(url: string, init?: unknown): Promise<unknown>;
}

/** A Polymarket market enriched with the fields the forecast needs beyond polymarketApi.PolyMarket. */
export interface RichMarket {
  readonly id: string;
  readonly question: string;
  readonly description: string;
  /** Current implied YES probability in [0,1]. */
  readonly yesPrice: number;
  /** CLOB token id of the YES outcome, used to query the price history. */
  readonly yesTokenId: string;
  readonly outcomes: readonly string[];
}

/** A short-term trend read off the YES-token CLOB price history. */
export interface PriceTrend {
  /** Number of history points read. */
  readonly points: number;
  /** Most recent YES price in the window (more current than Gamma's snapshot). */
  readonly latest: number;
  /** Least-squares slope of the price, expressed as probability change per hour. */
  readonly driftPerHour: number;
  /** Rough volatility: standard deviation of the price points in the window. */
  readonly volatility: number;
}

/** A detected underlying asset and a numeric threshold/direction pulled from the market text. */
export interface MarketSemantics {
  /** A Coinbase-quotable crypto ticker (BTC, ETH, ...) or null if not a known crypto underlying. */
  readonly cryptoTicker: string | null;
  /** A USD threshold parsed from the question, e.g. 57500 from "$57,500", or null. */
  readonly usdThreshold: number | null;
  /** Whether YES means the price goes DOWN to / below the threshold, UP to / above it, or unknown. */
  readonly direction: "down" | "up" | "unknown";
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

function firstObject(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return (value[0] ?? {}) as Record<string, unknown>;
  return (value ?? {}) as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Fetch one Polymarket market and extract the YES price, YES CLOB token id, and text. */
export async function fetchRichMarket(http: HttpLike, id: string): Promise<RichMarket> {
  const raw = firstObject(
    await http.getJson(`https://gamma-api.polymarket.com/markets/${encodeURIComponent(id)}`),
  );
  const outcomes = parseStringArray(raw.outcomes);
  const prices = parseStringArray(raw.outcomePrices).map((p) => Number(p));
  const tokens = parseStringArray(raw.clobTokenIds);
  const yesIdx = Math.max(0, outcomes.findIndex((o) => o.trim().toLowerCase() === "yes"));
  const yesPrice = Number.isFinite(prices[yesIdx]) ? (prices[yesIdx] as number) : 0;
  return {
    id: String(raw.id ?? id),
    question: String(raw.question ?? ""),
    description: String(raw.description ?? ""),
    yesPrice,
    yesTokenId: tokens[yesIdx] ?? "",
    outcomes,
  };
}

/**
 * Read the YES-token price history over the last `lookbackSeconds` and derive a short-term
 * trend. Uses the same CLOB endpoint the evaluator reads. Returns a flat (zero-drift) trend
 * anchored at `fallbackPrice` when no usable history is available.
 */
export async function fetchYesTrend(
  http: HttpLike,
  yesTokenId: string,
  nowSeconds: number,
  lookbackSeconds: number,
  fallbackPrice: number,
): Promise<PriceTrend> {
  const flat: PriceTrend = { points: 0, latest: fallbackPrice, driftPerHour: 0, volatility: 0 };
  if (yesTokenId.length === 0) return flat;

  const start = Math.max(0, nowSeconds - lookbackSeconds);
  const url =
    `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(yesTokenId)}` +
    `&startTs=${start}&endTs=${nowSeconds}&fidelity=1`;
  const body = firstObject(await http.getJson(url));
  const history = Array.isArray(body.history) ? body.history : [];

  const pts: Array<{ t: number; p: number }> = [];
  for (const point of history) {
    const rec = (point ?? {}) as Record<string, unknown>;
    const t = asNumber(rec.t);
    const p = asNumber(rec.p);
    if (t !== null && p !== null) pts.push({ t, p });
  }
  if (pts.length < 2) {
    return { ...flat, points: pts.length, latest: pts[pts.length - 1]?.p ?? fallbackPrice };
  }

  // Least-squares slope of p over t (seconds), then scaled to per-hour.
  const n = pts.length;
  const meanT = pts.reduce((s, q) => s + q.t, 0) / n;
  const meanP = pts.reduce((s, q) => s + q.p, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const q of pts) {
    const dt = q.t - meanT;
    sxx += dt * dt;
    sxy += dt * (q.p - meanP);
  }
  const slopePerSecond = sxx > 0 ? sxy / sxx : 0;
  const variance = pts.reduce((s, q) => s + (q.p - meanP) * (q.p - meanP), 0) / n;

  return {
    points: n,
    latest: pts[n - 1]?.p ?? fallbackPrice,
    driftPerHour: slopePerSecond * 3600,
    volatility: Math.sqrt(variance),
  };
}

const CRYPTO_TICKERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(bitcoin|btc)\b/i, "BTC"],
  [/\b(ethereum|ether|eth)\b/i, "ETH"],
  [/\b(solana|sol)\b/i, "SOL"],
  [/\b(sui)\b/i, "SUI"],
  [/\b(dogecoin|doge)\b/i, "DOGE"],
  [/\b(ripple|xrp)\b/i, "XRP"],
];

/** Parse the market text for a known crypto underlying, a USD threshold, and the YES direction. */
export function readSemantics(question: string, description: string): MarketSemantics {
  const text = `${question} ${description}`;

  let cryptoTicker: string | null = null;
  for (const [re, ticker] of CRYPTO_TICKERS) {
    if (re.test(text)) {
      cryptoTicker = ticker;
      break;
    }
  }

  // First "$<number>" with optional thousands separators / decimals.
  const money = /\$\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/.exec(text);
  const usdThreshold = money ? Number(money[1]?.replace(/,/g, "")) : null;

  const down = /\b(dip|drop|fall|below|under|less than|down to|crash)\b/i.test(question);
  const up = /\b(reach|hit|above|over|exceed|top|surpass|more than|up to|all[- ]time high|ath)\b/i.test(question);
  const direction: MarketSemantics["direction"] = down && !up ? "down" : up && !down ? "up" : "unknown";

  return {
    cryptoTicker,
    usdThreshold: usdThreshold !== null && Number.isFinite(usdThreshold) ? usdThreshold : null,
    direction,
  };
}

/** Fetch a crypto spot price in USD from Coinbase, or null if unavailable. */
export async function fetchSpotUsd(http: HttpLike, ticker: string): Promise<number | null> {
  try {
    const body = firstObject(
      await http.getJson(`https://api.coinbase.com/v2/prices/${encodeURIComponent(ticker)}-USD/spot`),
    );
    const data = (body.data ?? {}) as Record<string, unknown>;
    return asNumber(data.amount);
  } catch {
    return null; // spot is a cross-check only; never fail the forecast on it.
  }
}
