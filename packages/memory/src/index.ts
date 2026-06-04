import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StateDb } from "@atenea/state";
import { countWords } from "./word_count.js";
import { capKey, fileLabel, FLAT_FILES, resolveMemoryPath, type MemoryFile } from "./paths.js";

export { countWords } from "./word_count.js";
export { FLAT_FILES, fileLabel, resolveMemoryPath } from "./paths.js";
export type { MemoryFile, MemoryFileName } from "./paths.js";
export { defaultCompactor } from "./compactor.js";

export interface CapTable {
  "SOUL.md": number;
  "USER.md": number;
  "MEMORY.md": number;
  "AGENTS.md": number;
  "SKILLS.md": number;
  "LESSONS.md": number;
}

export const DEFAULT_CAPS: CapTable = {
  "SOUL.md": 400,
  "USER.md": 300,
  "MEMORY.md": 600,
  "AGENTS.md": 400,
  "SKILLS.md": 800,
  "LESSONS.md": 600,
};

export interface CompactorInput {
  file: string;
  text: string;
  targetWords: number;
}

export interface Compactor {
  compact(input: CompactorInput): Promise<string>;
}

export interface MemoryStoreOpts {
  memoryDir: string;
  caps?: Partial<CapTable>;
  compactor?: Compactor;
  stateDb?: StateDb;
  sessionId?: number;
}

export type WriteOutcome =
  | { kind: "written"; wordCount: number; cap: number }
  | { kind: "compacted"; wordCount: number; cap: number; droppedWords: number }
  | {
      kind: "refused";
      reason: "over_cap_no_compactor" | "compactor_failed";
      wordCount: number;
      cap: number;
      message: string;
    };

export interface MemoryStore {
  readonly memoryDir: string;
  read(file: MemoryFile): Promise<string | undefined>;
  write(file: MemoryFile, text: string): Promise<WriteOutcome>;
  capFor(file: MemoryFile): number;
  countWords(text: string): number;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export function createMemoryStore(opts: MemoryStoreOpts): MemoryStore {
  const caps: CapTable = { ...DEFAULT_CAPS, ...(opts.caps ?? {}) };

  function capFor(file: MemoryFile): number {
    return caps[capKey(file)];
  }

  async function write(file: MemoryFile, text: string): Promise<WriteOutcome> {
    const path = resolveMemoryPath(opts.memoryDir, file);
    const cap = capFor(file);
    const initialWords = countWords(text);

    if (initialWords <= cap) {
      await writeAtomic(path, text);
      return { kind: "written", wordCount: initialWords, cap };
    }

    if (!opts.compactor) {
      return {
        kind: "refused",
        reason: "over_cap_no_compactor",
        wordCount: initialWords,
        cap,
        message: `${fileLabel(file)} would be ${initialWords} words, cap ${cap}; no compactor configured`,
      };
    }

    const target = Math.floor(cap * 0.9);
    let compacted: string;
    try {
      compacted = await opts.compactor.compact({
        file: fileLabel(file),
        text,
        targetWords: target,
      });
    } catch (e) {
      return {
        kind: "refused",
        reason: "compactor_failed",
        wordCount: initialWords,
        cap,
        message: `compactor threw: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const afterWords = countWords(compacted);
    if (afterWords > cap) {
      return {
        kind: "refused",
        reason: "compactor_failed",
        wordCount: afterWords,
        cap,
        message: `compactor returned ${afterWords} words, still over cap ${cap}`,
      };
    }

    await writeAtomic(path, compacted);

    if (opts.stateDb && opts.sessionId !== undefined) {
      opts.stateDb.recordCompaction({
        sessionId: opts.sessionId,
        file: fileLabel(file),
        capWords: cap,
        beforeWords: initialWords,
        afterWords,
        beforeText: text,
        afterText: compacted,
      });
    }

    return {
      kind: "compacted",
      wordCount: afterWords,
      cap,
      droppedWords: initialWords - afterWords,
    };
  }

  return {
    memoryDir: opts.memoryDir,
    async read(file) {
      return readOptional(resolveMemoryPath(opts.memoryDir, file));
    },
    write,
    capFor,
    countWords,
  };
}
