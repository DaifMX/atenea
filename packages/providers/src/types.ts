// Normalized message + event types shared across providers.
// The agent core only ever sees these — never raw Anthropic or OpenAI shapes.

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolUsePart {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultPart {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentPart = TextPart | ToolUsePart | ToolResultPart;

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: ContentPart[];
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentPart[];
}

export type Message = SystemMessage | UserMessage | AssistantMessage;

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "error";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; partialJson: string }
  | { type: "tool_use_complete"; id: string; name: string; input: unknown }
  | { type: "message_complete"; stopReason: StopReason; finalContent: ContentPart[] }
  | { type: "error"; message: string };

export interface ProviderRequest {
  system: string;
  messages: Array<UserMessage | AssistantMessage>;
  tools: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
}

export interface Provider {
  readonly id: string;
  readonly kind: "anthropic" | "openai" | "openrouter";
  readonly model: string;
  streamMessages(req: ProviderRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}
