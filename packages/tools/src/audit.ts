import type { ToolContext } from "@atenea/core";
import type { ToolOutcome } from "@atenea/state";

export function auditCall(
  ctx: ToolContext,
  toolName: string,
  input: unknown,
  outcome: ToolOutcome,
  message?: string,
): void {
  if (!ctx.stateDb || ctx.sessionId === undefined) return;
  let inputJson: string;
  try {
    inputJson = JSON.stringify(input);
  } catch {
    inputJson = '"<unserializable>"';
  }
  const args: Parameters<typeof ctx.stateDb.recordToolCall>[0] = {
    sessionId: ctx.sessionId,
    toolName,
    inputJson,
    outcome,
  };
  if (message !== undefined) args.message = message;
  ctx.stateDb.recordToolCall(args);
}
