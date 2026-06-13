// errorClassification.ts — pure, network-free classification of thrown errors into the
// Walrus result `kind`s (separate from walrusService for isolated unit testing).
// GOTCHA: @mysten/walrus declares its error classes as anonymous expressions that never
// set this.name, so an instance has .name === "Error" but .constructor.name ===
// "BlobNotCertifiedError"; DOMException aborts are the mirror (kind lives in .name). So
// we classify against BOTH constructor name and .name — an open label set, not a closed
// discriminator.

// Known Walrus blob-class error names meaning "no live, certified blob at this id".
const BLOB_UNAVAILABLE_ERROR_NAMES = new Set<string>([
  "BlobNotCertifiedError",
  "BlobBlockedError",
]);

// Constructor names that are generic wrappers — for these the specific kind lives
// in `.name`, so they must not win the representative-label race.
const GENERIC_ERROR_NAMES = new Set<string>(["Error", "Object", "DOMException"]);

// Transient RPC / network signals. A recognized network timeout MUST map to
// network_error (never throw it through); only genuinely unclassifiable failures
// throw at the service layer.
const NETWORK_ERROR_NAME_RE =
  /RetryableWalrusClientError|FetchError|AbortError|TimeoutError|NetworkError/i;
const NETWORK_MESSAGE_RE =
  /timeout|timed out|fetch failed|network|ECONN|ECONNRESET|ECONNREFUSED|socket|getaddrinfo|ENOTFOUND|EAI_AGAIN|aggregator|503|502|504|429/i;

// Every name worth checking for an error: its constructor name AND its `.name`.
// Deduped, empties dropped. Order: constructor name first (the SDK class identity).
//
// `.name` is read structurally, NOT gated on `instanceof Error`: a real
// AbortError is a DOMException whose `.constructor.name` is the generic
// "DOMException" while the meaningful kind ("AbortError") lives only in `.name`.
// (DOMException's Error-subclass status varies across Node versions, so the
// structural read is the robust choice either way.) Gating the `.name` read on
// instanceof Error would risk dropping it and misclassifying the abort.
function nameCandidates(err: unknown): string[] {
  const obj = err as { name?: unknown; constructor?: { name?: unknown } } | null | undefined;
  const out: string[] = [];
  const ctor = obj?.constructor?.name;
  if (typeof ctor === "string" && ctor.length > 0) out.push(ctor);
  const own = obj?.name;
  if (typeof own === "string" && own.length > 0 && own !== ctor) out.push(own);
  return out;
}

// The single human/diagnostic label reported in results. Prefer a non-generic
// constructor name (the SDK class identity); otherwise fall back to `.name`
// (which carries the kind for generic wrappers like DOMException).
export function errorName(err: unknown): string {
  const candidates = nameCandidates(err);
  const specific = candidates.find((n) => !GENERIC_ERROR_NAMES.has(n));
  return specific ?? candidates[0] ?? typeof err;
}

export function errorMessage(err: unknown): string {
  const m = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof m === "string") return m;
  return String(err);
}

export type WalrusErrorKind = "blob_unavailable" | "network_error" | "unclassified";

export type ClassifiedWalrusError = {
  kind: WalrusErrorKind;
  errorName: string;
  message: string;
};

// Single classification entry point. store() and read() both route through this
// so their error handling cannot drift apart. blob_unavailable is checked before
// network_error because BlobNotCertifiedError extends RetryableWalrusClientError
// (it is retryable by inheritance) but must surface as blob_unavailable.
export function classifyWalrusError(err: unknown): ClassifiedWalrusError {
  const names = nameCandidates(err);
  const label = errorName(err);
  const message = errorMessage(err);

  if (names.some((n) => BLOB_UNAVAILABLE_ERROR_NAMES.has(n))) {
    return { kind: "blob_unavailable", errorName: label, message };
  }
  if (names.some((n) => NETWORK_ERROR_NAME_RE.test(n)) || NETWORK_MESSAGE_RE.test(message)) {
    return { kind: "network_error", errorName: label, message };
  }
  return { kind: "unclassified", errorName: label, message };
}
