import { access } from "node:fs/promises";
import { dirname, parse as parsePath, resolve } from "node:path";
import type { CliArgs } from "./args.js";

async function findConfigUpwards(start: string): Promise<string | undefined> {
  let dir = start;
  const { root } = parsePath(dir);
  while (true) {
    const candidate = resolve(dir, "atenea.toml");
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not here, keep walking
    }
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

export async function resolveConfigPath(args: CliArgs): Promise<string> {
  if (args.configPath) return resolve(args.configPath);
  const found = await findConfigUpwards(args.cwd);
  if (found) return found;
  throw new Error(
    `no atenea.toml found at or above ${args.cwd}.\n` +
      `Copy atenea.toml.example to atenea.toml at your project root, or pass --config <path>.`,
  );
}
