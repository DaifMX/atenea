import type { ProviderConfig } from "@atenea/config";
import { streamOpenAICompat, toOpenAIMessages, toOpenAITools } from "./openai_compat.js";
import type { Provider, ProviderRequest, StreamEvent } from "./types.js";

const DEFAULT_BASE = "https://api.openai.com/v1";

export class OpenAIProvider implements Provider {
  readonly id: string;
  readonly kind = "openai" as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;

  constructor(cfg: ProviderConfig) {
    if (cfg.kind !== "openai") throw new Error("OpenAIProvider requires kind=openai");
    this.id = cfg.id;
    this.model = cfg.model;
    this.#apiKey = cfg.apiKey;
    this.#baseUrl = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
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

    const compatReq: Parameters<typeof streamOpenAICompat>[0] = {
      url: `${this.#baseUrl}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#apiKey}`,
        accept: "text/event-stream",
      },
      body,
      errorTag: "openai",
    };
    if (signal) compatReq.signal = signal;
    return streamOpenAICompat(compatReq);
  }
}
