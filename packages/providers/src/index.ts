import type { ProviderConfig } from "@atenea/config";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import type { Provider } from "./types.js";

export * from "./types.js";
export { AnthropicProvider } from "./anthropic.js";
export { OpenAIProvider } from "./openai.js";
export { OpenRouterProvider } from "./openrouter.js";

export function createProvider(cfg: ProviderConfig): Provider {
  switch (cfg.kind) {
    case "anthropic":
      return new AnthropicProvider(cfg);
    case "openai":
      return new OpenAIProvider(cfg);
    case "openrouter":
      return new OpenRouterProvider(cfg);
  }
}
