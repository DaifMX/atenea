import { stdout as output } from "node:process";
import { createInterface } from "node:readline";
import { stdin as input } from "node:process";
import { getProvider, loadConfig } from "@atenea/config";
import { createProvider } from "@atenea/providers";
import {
  buildSystemPrompt,
  createApprovalGate,
  ToolRegistry,
  type ToolContext,
} from "@atenea/core";
import { createMemoryStore, defaultCompactor } from "@atenea/memory";
import { registerPhase0Tools, registerPhase2Tools } from "@atenea/tools";
import { parseArgs } from "./args.js";
import { resolveConfigPath } from "./config_path.js";
import { loadMemoryDocs } from "./memory.js";
import { runRepl } from "./repl.js";
import { openState, resolveAteneaHome } from "./state.js";
import { createReadlinePrompter } from "./approval_prompt.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configPath = await resolveConfigPath(args);
  const cfg = await loadConfig(configPath);
  const provider = createProvider(getProvider(cfg, args.providerId));

  const ateneaHome = resolveAteneaHome({
    flag: args.ateneaHome,
    env: process.env.ATENEA_HOME,
    configPath,
  });
  const stateDb = openState(ateneaHome);
  const session = stateDb.startSession({ providerId: provider.id, cwd: args.cwd });

  const rl = createInterface({ input, output, prompt: "you> " });
  const prompter = createReadlinePrompter(rl);

  const memory = createMemoryStore({
    memoryDir: cfg.memoryDir,
    compactor: defaultCompactor(provider),
    stateDb,
    sessionId: session.id,
  });
  const approval = createApprovalGate({ prompter, stateDb, sessionId: session.id });

  const registry = new ToolRegistry();
  registerPhase0Tools(registry);
  registerPhase2Tools(registry);

  const memoryDocs = await loadMemoryDocs(cfg.memoryDir);
  const systemPrompt = buildSystemPrompt(memoryDocs);
  const toolCtx: ToolContext = {
    cwd: args.cwd,
    approval,
    memory,
    stateDb,
    sessionId: session.id,
  };

  output.write(`ATENEA phase 2 — provider=${provider.id} (${provider.kind}:${provider.model})\n`);
  output.write(`config=${configPath}\n`);
  output.write(`cwd=${args.cwd}\n`);
  output.write(`state=${stateDb.path} (session ${session.id})\n`);
  output.write(`type /help for commands, /exit to quit\n\n`);

  const shutdown = (): void => {
    try {
      stateDb.endSession(session.id);
      stateDb.close();
    } catch {
      // best-effort
    }
  };

  process.on("exit", shutdown);

  runRepl({
    rl,
    provider,
    registry,
    systemPrompt,
    toolCtx,
    maxIterations: cfg.agent.maxIterations,
    memory,
    stateDb,
    sessionId: session.id,
  });
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
