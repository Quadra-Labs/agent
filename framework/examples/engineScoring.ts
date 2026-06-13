// examples/engineScoring.ts — a faithful TypeScript MIRROR of the evaluation engine's
// public scoring + oracle math, so the btc-price-guess agents below can self-report the
// score their interval would earn and normalize the Pyth feed EXACTLY the way the engine
// does. This is not a re-implementation of anything in our framework: it copies two small
// pure functions out of the Rust enclave so the agents can reason about it.
//
// Sources (kept verbatim in spirit):
//   - scoreInterval  <- evaluation-engine/src/nautilus-server/src/scoring/btc_price.rs (score_interval)
//   - normalizeToUsd <- evaluation-engine/src/nautilus-server/src/oracle.rs (normalize_to_usd)
//
// All values are whole USD (the engine works in u64 whole dollars). Integer division in
// Rust truncates toward zero; every value here is non-negative, so Math.floor matches.

/** BTC/USD Pyth feed id the engine resolves against (no 0x prefix, the way Hermes returns it). */
export const BTC_USD_FEED_ID =
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

/**
 * scoreInterval — the engine's exact scoring rule for a committed [minPrice, maxPrice]
 * interval against a resolved `price` (all whole USD):
 *   - price inside the interval        -> 100
 *   - price outside, within one width  -> linear decay 100*(width-distance)/width
 *   - price a full width or more away   -> 0
 * Throws on an invalid interval (maxPrice <= minPrice), mirroring the engine's rejection.
 */
export function scoreInterval(minPrice: number, maxPrice: number, price: number): number {
  if (maxPrice <= minPrice) {
    throw new Error("scoreInterval: maxPrice must be greater than minPrice");
  }
  if (price >= minPrice && price <= maxPrice) {
    return 100;
  }
  const width = maxPrice - minPrice;
  const distance = price < minPrice ? minPrice - price : price - maxPrice;
  if (distance >= width) {
    return 0;
  }
  // distance is in (0, width), so this is bounded to 1..=99.
  return Math.floor((100 * (width - distance)) / width);
}

/**
 * normalizeToUsd — turn Pyth's integer price string plus exponent into whole US dollars,
 * rounded to the nearest dollar, the SAME way the engine's oracle does. Pyth reports the
 * real value as `price * 10^expo` with expo usually negative (e.g. expo -8 -> the integer
 * is in 1e-8 units). Throws on a non-positive price, like the engine.
 */
export function normalizeToUsd(rawPrice: string, expo: number): number {
  const price = Number(rawPrice);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`normalizeToUsd: non-positive or non-numeric price: ${rawPrice}`);
  }
  if (expo < 0) {
    const scale = 10 ** -expo;
    // Add half the scale before dividing so we round to the nearest dollar.
    return Math.floor((price + scale / 2) / scale);
  }
  const scale = 10 ** expo;
  return price * scale;
}
