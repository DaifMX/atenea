import type { Interface as ReadlineInterface } from "node:readline";
import { stdout as output } from "node:process";
import type { AssistantMessage, Provider, UserMessage } from "@atenea/providers";
import { runTurn, type ToolContext, type ToolRegistry } from "@atenea/core";
import type { MemoryStore } from "@atenea/memory";
import type { StateDb } from "@atenea/state";
import { printUsage } from "./args.js";
import { handleMemoryCommand } from "./slash_memory.js";
import { handleApprovalsCommand } from "./slash_approvals.js";

export interface ReplOptions {
  rl: ReadlineInterface;
  provider: Provider;
  registry: ToolRegistry;
  systemPrompt: string;
  toolCtx: ToolContext;
  maxIterations: number;
  memory: MemoryStore;
  stateDb: StateDb;
  sessionId: number;
}

export function runRepl(opts: ReplOptions): void {
  const { rl, provider, registry, systemPrompt, toolCtx, maxIterations, memory, stateDb, sessionId } =
    opts;
  const history: Array<UserMessage | AssistantMessage> = [];

  rl.prompt();
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      return;
    }
    if (line === "/exit" || line === "/quit") {
      rl.close();
      return;
    }
    if (line === "/help") {
      printUsage();
      rl.prompt();
      return;
    }
    if (line === "/clear") {
      history.length = 0;
      output.write("(history cleared)\n");
      rl.prompt();
      return;
    }
    if (line.startsWith("/memory")) {
      handleMemoryCommand(memory, line.split(/\s+/).slice(1))
        .catch((e) => output.write(`(/memory error: ${e instanceof Error ? e.message : e})\n`))
        .finally(() => rl.prompt());
      return;
    }
    if (line.startsWith("/approvals")) {
      try {
        handleApprovalsCommand(stateDb, sessionId, line.split(/\s+/).slice(1));
      } catch (e) {
        output.write(`(/approvals error: ${e instanceof Error ? e.message : e})\n`);
      }
      rl.prompt();
      return;
    }
    if (line.startsWith("/")) {
      output.write(`unknown command: ${line}\n`);
      rl.prompt();
      return;
    }

    takeTurn({
      line,
      history,
      provider,
      registry,
      systemPrompt,
      toolCtx,
      maxIterations,
    })
      .catch((e) => {
        output.write(`\n(internal error: ${e instanceof Error ? e.message : String(e)})\n`);
      })
      .finally(() => rl.prompt());
  });

  rl.on("close", () => {
    output.write("\nbye.\n");
    process.exit(0);
  });
}

interface TurnArgs {
  line: string;
  history: Array<UserMessage | AssistantMessage>;
  provider: Provider;
  registry: ToolRegistry;
  systemPrompt: string;
  toolCtx: ToolContext;
  maxIterations: number;
}

async function takeTurn(args: TurnArgs): Promise<void> {
  const { line, history, provider, registry, systemPrompt, toolCtx, maxIterations } = args;
  output.write("atenea> ");
  let printedAny = false;
  const result = await runTurn(history, line, {
    provider,
    registry,
    system: systemPrompt,
    toolCtx,
    maxIterations,
    onEvent: (ev) => {
      if (ev.type === "text_delta") {
        output.write(ev.text);
        printedAny = true;
      }
    },
    onToolStart: (call) => {
      if (printedAny) output.write("\n");
      output.write(`[tool ${call.name}]\n`);
      printedAny = false;
    },
    onToolResult: (_id, content, isError) => {
      const preview = content.split("\n").slice(0, 4).join("\n");
      const tag = isError ? "tool-error" : "tool-ok";
      output.write(`[${tag}] ${preview}${content.includes("\n") ? "\n…\n" : "\n"}`);
      output.write("atenea> ");
    },
  });
  if (!result.finalText.endsWith("\n")) output.write("\n");
  if (result.stopReason === "max_iterations") {
    output.write(`(hit max_iterations=${result.iterations})\n`);
  } else if (result.stopReason === "error") {
    output.write(`(error: ${result.errorMessage})\n`);
  }
  history.length = 0;
  for (const m of result.messages) history.push(m);
}
