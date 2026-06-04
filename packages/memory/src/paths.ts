import { resolve, relative, isAbsolute } from "node:path";

export type MemoryFileName = "SOUL.md" | "USER.md" | "MEMORY.md" | "SKILLS.md" | "LESSONS.md";

export type MemoryFile = MemoryFileName | { kind: "AGENTS"; repo: string };

export const FLAT_FILES: MemoryFileName[] = [
  "SOUL.md",
  "USER.md",
  "MEMORY.md",
  "SKILLS.md",
  "LESSONS.md",
];

const SAFE_REPO_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function resolveMemoryPath(memoryDir: string, file: MemoryFile): string {
  const dir = resolve(memoryDir);
  if (typeof file === "string") {
    return resolve(dir, file);
  }
  const repo = file.repo;
  if (!SAFE_REPO_RE.test(repo) || repo.startsWith(".") || repo.includes("..")) {
    throw new Error(`memory: invalid AGENTS repo name '${repo}'`);
  }
  const abs = resolve(dir, "agents", `${repo}.md`);
  const rel = relative(dir, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`memory: AGENTS path escapes memory dir`);
  }
  return abs;
}

export function fileLabel(file: MemoryFile): string {
  return typeof file === "string" ? file : `AGENTS.md(${file.repo})`;
}

export function capKey(file: MemoryFile): MemoryFileName | "AGENTS.md" {
  return typeof file === "string" ? file : "AGENTS.md";
}
