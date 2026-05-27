import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface MemoryDocs {
  soulMd?: string;
  memoryMd?: string;
  userMd?: string;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export async function loadMemoryDocs(memoryDir: string): Promise<MemoryDocs> {
  const [soulMd, memoryMd, userMd] = await Promise.all([
    readOptional(resolve(memoryDir, "SOUL.md")),
    readOptional(resolve(memoryDir, "MEMORY.md")),
    readOptional(resolve(memoryDir, "USER.md")),
  ]);
  const docs: MemoryDocs = {};
  if (soulMd !== undefined) docs.soulMd = soulMd;
  if (memoryMd !== undefined) docs.memoryMd = memoryMd;
  if (userMd !== undefined) docs.userMd = userMd;
  return docs;
}
