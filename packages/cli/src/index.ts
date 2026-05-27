#!/usr/bin/env node
import { stdout as output } from "node:process";
import { getProvider, loadConfig } from "@atenea/config";
import { createProvider } from "@atenea/providers";
import { buildSystemPrompt, ToolRegistry, type ToolContext } from "@atenea/core";
import { registerPhase0Tools } from "@atenea/tools";
import { parseArgs } from "./args.js";
import { resolveConfigPath } from "./config_path.js";
import { loadMemoryDocs } from "./memory.js";
import { runRepl } from "./repl.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configPath = await resolveConfigPath(args);
  const cfg = await loadConfig(configPath);
  const provider = createProvider(getProvider(cfg, args.providerId));

  const registry = new ToolRegistry();
  registerPhase0Tools(registry);

  const memoryDocs = await loadMemoryDocs(cfg.memoryDir);
  const systemPrompt = buildSystemPrompt(memoryDocs);
  const toolCtx: ToolContext = { cwd: args.cwd };

  output.write(`ATENEA phase 0 — provider=${provider.id} (${provider.kind}:${provider.model})\n`);
  output.write(`config=${configPath}\n`);
  output.write(`cwd=${args.cwd}\n`);
  output.write(`type /help for commands, /exit to quit\n\n`);

  runRepl({
    provider,
    registry,
    systemPrompt,
    toolCtx,
    maxIterations: cfg.agent.maxIterations,
  });
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
