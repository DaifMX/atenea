// Shared chat-completions-style streaming logic used by every OpenAI-compatible
// backend (OpenAI itself, OpenRouter, Ollama, vLLM, etc.). The per-provider
// classes build URL + headers + body; this module owns translation and SSE.

import { parseSseStream } from "./sse.js";
import type {
  AssistantMessage,
  ContentPart,
  StopReason,
  StreamEvent,
  ToolSchema,
  UserMessage,
} from "./types.js";

export function toOpenAITools(tools: ToolSchema[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// OpenAI shape splits ATENEA's tool_result parts out of user messages into
// separate role=tool entries, and folds tool_use parts into the assistant
// message's tool_calls array.
export function toOpenAIMessages(
  system: string,
  msgs: Array<UserMessage | AssistantMessage>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  out.push({ role: "system", content: system });
  for (const m of msgs) {
    if (m.role === "user") {
      const textParts: string[] = [];
      for (const p of m.content) {
        if (p.type === "text") textParts.push(p.text);
        else if (p.type === "tool_result") {
          out.push({
            role: "tool",
            tool_call_id: p.toolUseId,
            content: p.isError ? `ERROR: ${p.content}` : p.content,
          });
        }
      }
      if (textParts.length > 0) out.push({ role: "user", content: textParts.join("\n") });
    } else {
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const p of m.content) {
        if (p.type === "text") textParts.push(p.text);
        else if (p.type === "tool_use") {
          toolCalls.push({
            id: p.id,
            type: "function",
            function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
          });
        }
      }
      const msg: Record<string, unknown> = {
        role: "assistant",
        content: textParts.join("\n") || null,
      };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      out.push(msg);
    }
  }
  return out;
}

export function mapFinishReason(r: string | null | undefined): StopReason {
  switch (r) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

export interface OpenAICompatRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  errorTag: string; // e.g. "openai" / "openrouter" — used in error messages
  signal?: AbortSignal;
}

export async function* streamOpenAICompat(req: OpenAICompatRequest): AsyncGenerator<StreamEvent> {
  const fetchInit: RequestInit = {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(req.body),
  };
  if (req.signal) fetchInit.signal = req.signal;

  const res = await fetch(req.url, fetchInit);

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    yield { type: "error", message: `${req.errorTag} ${res.status}: ${text.slice(0, 500)}` };
    return;
  }

  let textAcc = "";
  const toolAcc: Map<number, { id: string; name: string; argsAcc: string; emittedStart: boolean }> =
    new Map();
  let finish: StopReason = "end_turn";

  for await (const ev of parseSseStream(res.body)) {
    if (!ev.data || ev.data === "[DONE]") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      continue;
    }
    const p = payload as Record<string, unknown>;
    const choices = p.choices as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) continue;
    const c = choices[0];
    if (!c) continue;
    const delta = c.delta as Record<string, unknown> | undefined;

    if (delta?.content && typeof delta.content === "string") {
      textAcc += delta.content;
      yield { type: "text_delta", text: delta.content };
    }
    const toolCalls = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const idx = (tc.index as number) ?? 0;
        let entry = toolAcc.get(idx);
        if (!entry) {
          entry = { id: "", name: "", argsAcc: "", emittedStart: false };
          toolAcc.set(idx, entry);
        }
        if (typeof tc.id === "string" && tc.id) entry.id = tc.id;
        const fn = tc.function as Record<string, unknown> | undefined;
        if (fn) {
          if (typeof fn.name === "string" && fn.name) entry.name = fn.name;
          if (typeof fn.arguments === "string") entry.argsAcc += fn.arguments;
        }
        if (!entry.emittedStart && entry.id && entry.name) {
          entry.emittedStart = true;
          yield { type: "tool_use_start", id: entry.id, name: entry.name };
        }
        if (entry.emittedStart && typeof fn?.arguments === "string" && fn.arguments) {
          yield {
            type: "tool_use_input_delta",
            id: entry.id,
            partialJson: fn.arguments,
          };
        }
      }
    }
    if (typeof c.finish_reason === "string") {
      finish = mapFinishReason(c.finish_reason);
    }
  }

  const finalContent: ContentPart[] = [];
  if (textAcc) finalContent.push({ type: "text", text: textAcc });
  for (const entry of toolAcc.values()) {
    if (!entry.id || !entry.name) continue;
    let input: unknown = {};
    if (entry.argsAcc.length > 0) {
      try {
        input = JSON.parse(entry.argsAcc);
      } catch {
        input = {};
      }
    }
    finalContent.push({ type: "tool_use", id: entry.id, name: entry.name, input });
    yield { type: "tool_use_complete", id: entry.id, name: entry.name, input };
  }
  yield { type: "message_complete", stopReason: finish, finalContent };
}
