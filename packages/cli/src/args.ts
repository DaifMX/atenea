import { resolve } from "node:path";
import { stdout as output } from "node:process";

export interface CliArgs {
  configPath: string | undefined;
  cwd: string;
  providerId?: string;
}

export function printUsage(): void {
  output.write(`atenea — phase 0 REPL

Usage: atenea [--config atenea.toml] [--cwd .] [--provider <id>]

Commands inside the REPL:
  /exit, /quit       leave
  /clear             drop conversation history
  /help              show this message
`);
}

export function parseArgs(argv: string[]): CliArgs {
  let configPath: string | undefined;
  let cwd = process.cwd();
  let providerId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "-c") {
      const next = argv[++i];
      if (!next) throw new Error(`${a} requires a path`);
      configPath = next;
    } else if (a === "--cwd") {
      const next = argv[++i];
      if (!next) throw new Error(`${a} requires a path`);
      cwd = resolve(next);
    } else if (a === "--provider" || a === "-p") {
      const next = argv[++i];
      if (!next) throw new Error(`${a} requires an id`);
      providerId = next;
    } else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  const out: CliArgs = { configPath, cwd };
  if (providerId !== undefined) out.providerId = providerId;
  return out;
}
