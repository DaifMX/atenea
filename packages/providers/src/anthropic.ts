import type { ProviderConfig } from "@atenea/config";
import { parseSseStream } from "./sse.js";
import type {
  ContentPart,
  Provider,
  ProviderRequest,
  StreamEvent,
  ToolSchema,
  UserMessage,
  AssistantMessage,
  StopReason,
} from "./types.js";

const DEFAULT_BASE = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

function toAnthropicTools(tools: ToolSchema[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

function toAnthropicMessages(msgs: Array<UserMessage | AssistantMessage>) {
  return msgs.map((m) => ({
    role: m.role,
    content: m.content.map((p): Record<string, unknown> => {
      switch (p.type) {
        case "text":
          return { type: "text", text: p.text };
        case "tool_use":
          return { type: "tool_use", id: p.id, name: p.name, input: p.input ?? {} };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: p.toolUseId,
            content: p.content,
            ...(p.isError ? { is_error: true } : {}),
          };
      }
    }),
  }));
}

function mapStopReason(r: string | null | undefined): StopReason {
  switch (r) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly kind = "anthropic" as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;

  constructor(cfg: ProviderConfig) {
    if (cfg.kind !== "anthropic") throw new Error("AnthropicProvider requires kind=anthropic");
    this.id = cfg.id;
    this.model = cfg.model;
    this.#apiKey = cfg.apiKey;
    this.#baseUrl = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  }

  async *streamMessages(req: ProviderRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const body = {
      model: this.model,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      tools: toAnthropicTools(req.tools),
      stream: true,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };

    const fetchInit: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#apiKey,
        "anthropic-version": API_VERSION,
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    };
    if (signal) fetchInit.signal = signal;

    const res = await fetch(`${this.#baseUrl}/v1/messages`, fetchInit);

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      yield { type: "error", message: `anthropic ${res.status}: ${text.slice(0, 500)}` };
      return;
    }

    // Accumulate per-block state to emit normalized events.
    const blocks: Map<
      number,
      { type: "text" | "tool_use"; id?: string; name?: string; text: string; jsonAcc: string }
    > = new Map();
    const finalContent: ContentPart[] = [];
    let stopReason: StopReason = "end_turn";

    for await (const ev of parseSseStream(res.body)) {
      if (!ev.data || ev.data === "[DONE]") continue;
      let payload: unknown;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const p = payload as Record<string, unknown>;
      const type = (p.type as string) ?? ev.event;

      switch (type) {
        case "content_block_start": {
          const idx = p.index as number;
          const block = p.content_block as Record<string, unknown>;
          if (block.type === "text") {
            blocks.set(idx, { type: "text", text: "", jsonAcc: "" });
          } else if (block.type === "tool_use") {
            const id = block.id as string;
            const name = block.name as string;
            blocks.set(idx, { type: "tool_use", id, name, text: "", jsonAcc: "" });
            yield { type: "tool_use_start", id, name };
          }
          break;
        }
        case "content_block_delta": {
          const idx = p.index as number;
          const delta = p.delta as Record<string, unknown>;
          const block = blocks.get(idx);
          if (!block) break;
          if (delta.type === "text_delta") {
            const t = (delta.text as string) ?? "";
            block.text += t;
            if (t) yield { type: "text_delta", text: t };
          } else if (delta.type === "input_json_delta") {
            const pj = (delta.partial_json as string) ?? "";
            block.jsonAcc += pj;
            if (block.id) yield { type: "tool_use_input_delta", id: block.id, partialJson: pj };
          }
          break;
        }
        case "content_block_stop": {
          const idx = p.index as number;
          const block = blocks.get(idx);
          if (!block) break;
          if (block.type === "text") {
            finalContent.push({ type: "text", text: block.text });
          } else if (block.type === "tool_use" && block.id && block.name) {
            let input: unknown = {};
            if (block.jsonAcc.length > 0) {
              try {
                input = JSON.parse(block.jsonAcc);
              } catch {
                input = {};
              }
            }
            finalContent.push({ type: "tool_use", id: block.id, name: block.name, input });
            yield { type: "tool_use_complete", id: block.id, name: block.name, input };
          }
          break;
        }
        case "message_delta": {
          const delta = p.delta as Record<string, unknown> | undefined;
          if (delta && typeof delta.stop_reason === "string") {
            stopReason = mapStopReason(delta.stop_reason);
          }
          break;
        }
        case "message_stop": {
          yield { type: "message_complete", stopReason, finalContent };
          return;
        }
        case "error": {
          const err = p.error as Record<string, unknown> | undefined;
          yield { type: "error", message: (err?.message as string) ?? "anthropic stream error" };
          return;
        }
      }
    }
    // Stream ended without explicit message_stop.
    yield { type: "message_complete", stopReason, finalContent };
  }
}
