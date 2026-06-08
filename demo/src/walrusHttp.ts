// Wallet-free Walrus client over the PUBLIC testnet HTTP endpoints.
//
// REAL WALRUS ONLY. There is deliberately NO local fallback (locked decision in
// PLAN.md, Track B): the demo's checkpoint memory must genuinely live on Walrus,
// so any connectivity/endpoint problem MUST surface as a thrown WalrusHttpError
// rather than being silently masked by a local stand-in.
//
// Endpoints (overridable via config, default to the public testnet):
//   publisher  PUT  {publisher}/v1/blobs?epochs=N   -> stores raw bytes, returns JSON
//   aggregator GET  {aggregator}/v1/blobs/{blobId}  -> returns raw bytes
//
// CRITICAL: a multi-epoch storage window is required. Phase 0 proved epochs=1
// certifies but is NOT retrievable, so the default here is epochs=5.

const DEFAULT_EPOCHS = 5;

export interface WalrusHttpConfig {
  readonly publisherUrl: string;
  readonly aggregatorUrl: string;
  /** Storage window in epochs. Must be > 1 (epochs=1 is not retrievable). */
  readonly epochs?: number;
}

/**
 * Typed error for every Walrus HTTP failure (non-2xx OR network/parse failure).
 * Carries the operation, URL, optional HTTP status, optional response body
 * snippet, and the underlying cause so callers can report a real problem.
 */
export class WalrusHttpError extends Error {
  readonly operation: string;
  readonly url: string;
  readonly status?: number;
  readonly body?: string;

  constructor(params: {
    message: string;
    operation: string;
    url: string;
    status?: number;
    body?: string;
    cause?: unknown;
  }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = "WalrusHttpError";
    this.operation = params.operation;
    this.url = params.url;
    this.status = params.status;
    this.body = params.body;
  }
}

// Shape of the publisher store response. Both variants carry the blobId in a
// different place; we read whichever is present.
interface StoreResponse {
  newlyCreated?: { blobObject?: { blobId?: string } };
  alreadyCertified?: { blobId?: string };
}

function epochsOf(config: WalrusHttpConfig): number {
  const value = config.epochs ?? DEFAULT_EPOCHS;
  return value > 1 ? value : DEFAULT_EPOCHS;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function bodySnippet(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    return text.length > 500 ? `${text.slice(0, 500)}...` : text;
  } catch {
    return undefined;
  }
}

function parseBlobId(json: StoreResponse): string | undefined {
  return json.newlyCreated?.blobObject?.blobId ?? json.alreadyCertified?.blobId;
}

/**
 * Store raw bytes on Walrus via the public publisher. Returns the blobId.
 * Throws WalrusHttpError on any non-2xx response, network failure, or if the
 * blobId cannot be parsed from either response shape.
 */
export async function storeBlob(
  config: WalrusHttpConfig,
  bytes: Uint8Array,
): Promise<{ blobId: string }> {
  const epochs = epochsOf(config);
  const url = `${trimTrailingSlash(config.publisherUrl)}/v1/blobs?epochs=${epochs}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "PUT",
      // Copy into a fresh ArrayBuffer so the body is a plain BodyInit regardless
      // of the input view's backing buffer.
      body: bytes.slice(),
    });
  } catch (cause) {
    throw new WalrusHttpError({
      message: `Walrus store request failed (network): ${String(cause)}`,
      operation: "storeBlob",
      url,
      cause,
    });
  }

  if (!response.ok) {
    const body = await bodySnippet(response);
    throw new WalrusHttpError({
      message: `Walrus store returned HTTP ${response.status} for ${url}`,
      operation: "storeBlob",
      url,
      status: response.status,
      body,
    });
  }

  let json: StoreResponse;
  try {
    json = (await response.json()) as StoreResponse;
  } catch (cause) {
    throw new WalrusHttpError({
      message: `Walrus store response was not valid JSON: ${String(cause)}`,
      operation: "storeBlob",
      url,
      status: response.status,
      cause,
    });
  }

  const blobId = parseBlobId(json);
  if (!blobId) {
    throw new WalrusHttpError({
      message:
        "Walrus store response had no blobId (checked newlyCreated.blobObject.blobId and alreadyCertified.blobId)",
      operation: "storeBlob",
      url,
      status: response.status,
      body: JSON.stringify(json).slice(0, 500),
    });
  }

  return { blobId };
}

/**
 * Read a blob's bytes from Walrus via the public aggregator. Throws
 * WalrusHttpError on any non-2xx response (including 404 not-yet-available) or
 * network failure.
 */
export async function readBlob(
  config: WalrusHttpConfig,
  blobId: string,
): Promise<Uint8Array> {
  const url = `${trimTrailingSlash(config.aggregatorUrl)}/v1/blobs/${blobId}`;

  let response: Response;
  try {
    response = await fetch(url, { method: "GET" });
  } catch (cause) {
    throw new WalrusHttpError({
      message: `Walrus read request failed (network): ${String(cause)}`,
      operation: "readBlob",
      url,
      cause,
    });
  }

  if (!response.ok) {
    const body = await bodySnippet(response);
    throw new WalrusHttpError({
      message: `Walrus read returned HTTP ${response.status} for ${url}`,
      operation: "readBlob",
      url,
      status: response.status,
      body,
    });
  }

  try {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  } catch (cause) {
    throw new WalrusHttpError({
      message: `Walrus read failed to buffer response body: ${String(cause)}`,
      operation: "readBlob",
      url,
      status: response.status,
      cause,
    });
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Confirm the public Walrus endpoints are usable THIS run by storing a tiny probe
 * blob and reading it back byte-exact. Throws WalrusHttpError with a clear message
 * on any failure. Never degrades to local storage.
 */
export async function assertReachable(config: WalrusHttpConfig): Promise<void> {
  const probe = new TextEncoder().encode(`walrus-demo-probe:${Date.now()}`);

  let blobId: string;
  try {
    ({ blobId } = await storeBlob(config, probe));
  } catch (cause) {
    throw new WalrusHttpError({
      message: `Walrus testnet unreachable: store probe failed (${describe(cause)}). The demo requires a live Walrus testnet connection.`,
      operation: "assertReachable",
      url: config.publisherUrl,
      cause,
    });
  }

  let readBack: Uint8Array;
  try {
    readBack = await readBlob(config, blobId);
  } catch (cause) {
    throw new WalrusHttpError({
      message: `Walrus testnet unreachable: probe stored as ${blobId} but read-back failed (${describe(cause)}). The demo requires a live Walrus testnet connection.`,
      operation: "assertReachable",
      url: config.aggregatorUrl,
      cause,
    });
  }

  if (!bytesEqual(probe, readBack)) {
    throw new WalrusHttpError({
      message: `Walrus testnet probe did not round-trip byte-exact (blobId ${blobId}, sent ${probe.length} bytes, got ${readBack.length}). The demo requires a live Walrus testnet connection.`,
      operation: "assertReachable",
      url: config.aggregatorUrl,
    });
  }
}

// Compact detail string for nesting one Walrus error message inside another.
function describe(cause: unknown): string {
  if (cause instanceof WalrusHttpError) {
    return cause.status !== undefined ? `HTTP ${cause.status}` : cause.message;
  }
  return String(cause);
}
