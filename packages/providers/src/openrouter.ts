import type { ProviderConfig } from "@atenea/config";
import {
  streamOpenAICompat,
  toOpenAIMessages,
  toOpenAITools,
} from "./openai_compat.js";
import type { Provider, ProviderRequest, StreamEvent } from "./types.js";

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

export class OpenRouterProvider implements Provider {
  readonly id: string;
  readonly kind = "openrouter" as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #referer: string | undefined;
  readonly #title: string | undefined;

  constructor(cfg: ProviderConfig) {
    if (cfg.kind !== "openrouter") throw new Error("OpenRouterProvider requires kind=openrouter");
    this.id = cfg.id;
    this.model = cfg.model;
    this.#apiKey = cfg.apiKey;
    this.#baseUrl = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    // Optional headers OpenRouter uses for rankings on their dashboard.
    this.#referer = cfg.httpReferer;
    this.#title = cfg.xTitle;
  }

  streamMessages(req: ProviderRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(req.system, req.messages),
      stream: true,
      max_tokens: req.maxTokens ?? 4096,
    };
    if (req.tools.length > 0) body.tools = toOpenAITools(req.tools);
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.#apiKey}`,
      accept: "text/event-stream",
    };
    if (this.#referer) headers["HTTP-Referer"] = this.#referer;
    if (this.#title) headers["X-Title"] = this.#title;

    const compatReq: Parameters<typeof streamOpenAICompat>[0] = {
      url: `${this.#baseUrl}/chat/completions`,
      headers,
      body,
      errorTag: "openrouter",
    };
    if (signal) compatReq.signal = signal;
    return streamOpenAICompat(compatReq);
  }
}
