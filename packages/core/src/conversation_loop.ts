import type {
  AssistantMessage,
  ContentPart,
  Provider,
  StreamEvent,
  ToolUsePart,
  UserMessage,
} from "@atenea/providers";
import { executeToolCalls } from "./tool_executor.js";
import type { ToolContext, ToolRegistry } from "./tool.js";

export interface LoopOptions {
  provider: Provider;
  registry: ToolRegistry;
  system: string;
  toolCtx: ToolContext;
  maxIterations: number;
  // Optional sink for live UI/CLI rendering of stream events.
  onEvent?: (ev: StreamEvent) => void;
  onToolStart?: (call: ToolUsePart) => void;
  onToolResult?: (toolUseId: string, content: string, isError: boolean) => void;
}

export interface TurnResult {
  finalText: string;
  iterations: number;
  stopReason: "end_turn" | "max_iterations" | "error";
  errorMessage?: string;
  messages: Array<UserMessage | AssistantMessage>;
}

function collectToolUses(content: ContentPart[]): ToolUsePart[] {
  return content.filter((p): p is ToolUsePart => p.type === "tool_use");
}

function collectText(content: ContentPart[]): string {
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export async function runTurn(
  history: Array<UserMessage | AssistantMessage>,
  userInput: string,
  opts: LoopOptions,
): Promise<TurnResult> {
  const messages: Array<UserMessage | AssistantMessage> = [
    ...history,
    { role: "user", content: [{ type: "text", text: userInput }] },
  ];

  let lastText = "";
  for (let i = 1; i <= opts.maxIterations; i++) {
    const stream = opts.provider.streamMessages({
      system: opts.system,
      messages,
      tools: opts.registry.schemas(),
    });

    let assistantContent: ContentPart[] = [];
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "error" = "end_turn";
    let streamError: string | undefined;

    for await (const ev of stream) {
      opts.onEvent?.(ev);
      if (ev.type === "message_complete") {
        assistantContent = ev.finalContent;
        stopReason = ev.stopReason;
      } else if (ev.type === "error") {
        streamError = ev.message;
        stopReason = "error";
      }
    }

    if (streamError) {
      return {
        finalText: lastText,
        iterations: i,
        stopReason: "error",
        errorMessage: streamError,
        messages,
      };
    }

    messages.push({ role: "assistant", content: assistantContent });
    lastText = collectText(assistantContent) || lastText;

    const toolCalls = collectToolUses(assistantContent);
    if (toolCalls.length === 0 || stopReason !== "tool_use") {
      return { finalText: lastText, iterations: i, stopReason: "end_turn", messages };
    }

    for (const tc of toolCalls) opts.onToolStart?.(tc);

    const results = await executeToolCalls(toolCalls, {
      registry: opts.registry,
      ctx: opts.toolCtx,
    });

    for (const r of results) {
      opts.onToolResult?.(r.toolUseId, r.content, r.isError ?? false);
    }

    messages.push({ role: "user", content: results });
  }

  return {
    finalText: lastText,
    iterations: opts.maxIterations,
    stopReason: "max_iterations",
    messages,
  };
}
