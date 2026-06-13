// models.ts — multi-provider model layer: ModelSpec helpers, raw-fetch clients, and
// the fallback chain. Host-side config: resolved keys live only inside the generate()
// closure, so the sealed onTurn ctx never sees a key or process.env.
//
// INVARIANT (lazy env): constructors and builders read NO process.env — all key/baseUrl
// resolution happens per generate() call. Hosts load .env after importing agent modules,
// and a missing key must be a chain-fallthrough failure, never a construction throw.

import type { LoopModel } from "./session/loopContext.js";

export type ProviderName =
  | "openai"
  | "anthropic"
  | "groq"
  | "openrouter"
  | "zai"
  | "local"
  | "custom";

/** One model on one provider. apiKey/baseUrl override the provider defaults; absent
 *  values resolve from the provider's env vars at call time. */
export interface ModelSpec {
  readonly provider: ProviderName;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Anthropic requires max_tokens (default 4096); OpenAI-compatible: sent only when set. */
  readonly maxTokens?: number;
}

export interface ProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
}

interface ProviderInfo {
  readonly defaultBaseUrl?: string;
  readonly envKey: string;
  readonly envBaseUrl?: string;
  readonly keyRequired: boolean;
  readonly api: "chat-completions" | "anthropic-messages";
}

const PROVIDERS: Record<ProviderName, ProviderInfo> = {
  openai: {
    defaultBaseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    keyRequired: true,
    api: "chat-completions",
  },
  anthropic: {
    defaultBaseUrl: "https://api.anthropic.com/v1",
    envKey: "ANTHROPIC_API_KEY",
    keyRequired: true,
    api: "anthropic-messages",
  },
  groq: {
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    keyRequired: true,
    api: "chat-completions",
  },
  openrouter: {
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    keyRequired: true,
    api: "chat-completions",
  },
  zai: {
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    envKey: "ZAI_API_KEY",
    keyRequired: true,
    api: "chat-completions",
  },
  local: {
    // Ollama default; LM Studio is http://localhost:1234/v1 via baseUrl/env.
    defaultBaseUrl: "http://localhost:11434/v1",
    envKey: "LOCAL_MODEL_API_KEY",
    envBaseUrl: "LOCAL_MODEL_BASE_URL",
    keyRequired: false,
    api: "chat-completions",
  },
  custom: {
    // Any OpenAI-compatible endpoint; baseUrl is required (option or env).
    envKey: "CUSTOM_MODEL_API_KEY",
    envBaseUrl: "CUSTOM_MODEL_BASE_URL",
    keyRequired: false,
    api: "chat-completions",
  },
};

function spec(provider: ProviderName, model: string, options?: ProviderOptions): ModelSpec {
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new Error(`${provider}(): "model" must be a non-empty string`);
  }
  return {
    provider,
    model: model.trim(),
    ...(options?.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options?.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
  };
}

/** OpenAI (api.openai.com). Key: apiKey option or OPENAI_API_KEY. */
export const openai = (model: string, options?: ProviderOptions): ModelSpec =>
  spec("openai", model, options);
/** Anthropic Messages API. Key: apiKey option or ANTHROPIC_API_KEY. */
export const anthropic = (model: string, options?: ProviderOptions): ModelSpec =>
  spec("anthropic", model, options);
/** Groq (OpenAI-compatible). Key: apiKey option or GROQ_API_KEY. */
export const groq = (model: string, options?: ProviderOptions): ModelSpec =>
  spec("groq", model, options);
/** OpenRouter (OpenAI-compatible). Key: apiKey option or OPENROUTER_API_KEY. */
export const openrouter = (model: string, options?: ProviderOptions): ModelSpec =>
  spec("openrouter", model, options);
/** z.ai (OpenAI-compatible, GLM models). Key: apiKey option or ZAI_API_KEY. */
export const zai = (model: string, options?: ProviderOptions): ModelSpec =>
  spec("zai", model, options);
/** Local OpenAI-compatible server (Ollama default; LM Studio via baseUrl). Key optional. */
export const local = (model: string, options?: ProviderOptions): ModelSpec =>
  spec("local", model, options);
/** Any OpenAI-compatible endpoint. baseUrl required (option or CUSTOM_MODEL_BASE_URL). */
export const custom = (model: string, options?: ProviderOptions): ModelSpec =>
  spec("custom", model, options);

const label = (s: ModelSpec): string => `${s.provider}/${s.model}`;

function resolveKey(s: ModelSpec): string | undefined {
  if (s.apiKey !== undefined && s.apiKey.trim().length > 0) return s.apiKey.trim();
  const fromEnv = (process.env[PROVIDERS[s.provider].envKey] ?? "").trim();
  return fromEnv.length > 0 ? fromEnv : undefined;
}

function resolveBaseUrl(s: ModelSpec): string | undefined {
  if (s.baseUrl !== undefined && s.baseUrl.trim().length > 0) return s.baseUrl.trim();
  const info = PROVIDERS[s.provider];
  if (info.envBaseUrl !== undefined) {
    const fromEnv = (process.env[info.envBaseUrl] ?? "").trim();
    if (fromEnv.length > 0) return fromEnv;
  }
  return info.defaultBaseUrl;
}

export interface ProviderModelOptions {
  /** Test seam; defaults to the global fetch. */
  readonly fetchFn?: typeof fetch;
}

/** Build a LoopModel for one ModelSpec over raw fetch. Throws (naming provider/model)
 *  on missing key, missing baseUrl, non-2xx, or empty completion. */
export function makeProviderModel(
  modelSpec: ModelSpec,
  options?: ProviderModelOptions,
): LoopModel {
  const info = PROVIDERS[modelSpec.provider];
  if (info === undefined) {
    throw new Error(`makeProviderModel: unknown provider "${modelSpec.provider}"`);
  }
  const fetchFn = options?.fetchFn ?? fetch;
  const who = label(modelSpec);

  return {
    async generate(prompt: string): Promise<string> {
      const key = resolveKey(modelSpec);
      if (key === undefined && info.keyRequired) {
        throw new Error(`[model] ${who}: no API key (set ${info.envKey} or pass apiKey)`);
      }
      const baseUrl = resolveBaseUrl(modelSpec);
      if (baseUrl === undefined) {
        throw new Error(
          `[model] ${who}: no base URL (set ${info.envBaseUrl ?? "baseUrl"} or pass baseUrl)`,
        );
      }
      const base = baseUrl.replace(/\/+$/, "");

      let url: string;
      let headers: Record<string, string>;
      let body: unknown;
      if (info.api === "anthropic-messages") {
        url = `${base}/messages`;
        headers = {
          "content-type": "application/json",
          "x-api-key": key ?? "",
          "anthropic-version": "2023-06-01",
        };
        body = {
          model: modelSpec.model,
          max_tokens: modelSpec.maxTokens ?? 4096,
          messages: [{ role: "user", content: prompt }],
        };
      } else {
        url = `${base}/chat/completions`;
        headers = {
          "content-type": "application/json",
          ...(key !== undefined ? { authorization: `Bearer ${key}` } : {}),
        };
        body = {
          model: modelSpec.model,
          messages: [{ role: "user", content: prompt }],
          ...(modelSpec.maxTokens !== undefined ? { max_tokens: modelSpec.maxTokens } : {}),
        };
      }

      const res = await fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // Collapse whitespace so multi-line error bodies stay one readable log line.
        const snippet = (await res.text().catch(() => ""))
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        throw new Error(`[model] ${who}: HTTP ${res.status}${snippet ? ` — ${snippet}` : ""}`);
      }
      const json = (await res.json()) as Record<string, unknown>;
      const text =
        info.api === "anthropic-messages"
          ? extractAnthropicText(json)
          : extractChatCompletionText(json);
      if (text === undefined || text.trim().length === 0) {
        throw new Error(`[model] ${who}: empty completion`);
      }
      return text.trim();
    },
  };
}

function extractChatCompletionText(json: Record<string, unknown>): string | undefined {
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  return typeof message?.content === "string" ? message.content : undefined;
}

function extractAnthropicText(json: Record<string, unknown>): string | undefined {
  const content = json.content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0] as { text?: unknown };
  return typeof first.text === "string" ? first.text : undefined;
}

export interface ModelChainOptions {
  readonly fetchFn?: typeof fetch;
  /** Receives each fallback log line; defaults to console.log. */
  readonly onFallback?: (line: string) => void;
}

/** Build a LoopModel that tries each spec in order, falling back on ANY failure.
 *  First spec = base model; throws an aggregate error only when all fail. */
export function makeModelChain(
  specs: readonly ModelSpec[],
  options?: ModelChainOptions,
): LoopModel {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error("makeModelChain: at least one ModelSpec is required");
  }
  for (const s of specs) {
    if (s === null || typeof s !== "object" || !(s.provider in PROVIDERS) ||
        typeof s.model !== "string" || s.model.trim().length === 0) {
      throw new Error("makeModelChain: every entry must be a ModelSpec with provider and model");
    }
  }
  const models = specs.map((s) => makeProviderModel(s, { fetchFn: options?.fetchFn }));
  const log = options?.onFallback ?? ((line: string) => console.log(line));

  return {
    async generate(prompt: string): Promise<string> {
      const failures: string[] = [];
      for (let i = 0; i < models.length; i += 1) {
        try {
          return await models[i].generate(prompt);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          failures.push(`${label(specs[i])} (${reason})`);
          if (i + 1 < models.length) {
            log(`[model] ${label(specs[i])} failed (${reason}) -> trying ${label(specs[i + 1])}`);
          }
        }
      }
      throw new Error(
        `[model] all ${models.length} providers failed: ${failures.join("; ")}`,
      );
    },
  };
}

/** Human-readable chain status for host banners: env var NAMES only, never values. */
export function describeModels(specs: readonly ModelSpec[]): readonly string[] {
  return specs.map((s) => {
    const info = PROVIDERS[s.provider];
    if (s.apiKey !== undefined) return `${label(s)}: explicit apiKey`;
    if (!info.keyRequired) return `${label(s)}: no key required`;
    const present = (process.env[info.envKey] ?? "").trim().length > 0;
    return `${label(s)}: ${info.envKey} ${present ? "present" : "MISSING"}`;
  });
}

/** True when at least one spec could work: explicit key, env key present, or a
 *  key-optional provider (local/custom — statically unverifiable, counts as usable). */
export function hasUsableProvider(specs: readonly ModelSpec[]): boolean {
  return specs.some((s) => {
    const info = PROVIDERS[s.provider];
    if (!info.keyRequired) return true;
    if (s.apiKey !== undefined && s.apiKey.trim().length > 0) return true;
    return (process.env[info.envKey] ?? "").trim().length > 0;
  });
}
