import { isAbsolute, relative, resolve } from "node:path";

export function resolveSafe(cwd: string, path: string): string {
  const abs = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const rel = relative(cwd, abs);
  if (rel.startsWith("..")) {
    throw new Error(`path '${path}' escapes the working directory`);
  }
  return abs;
}
