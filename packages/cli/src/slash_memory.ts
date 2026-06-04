import { stdout as output } from "node:process";
import {
  FLAT_FILES,
  fileLabel,
  type MemoryFile,
  type MemoryFileName,
  type MemoryStore,
} from "@atenea/memory";

const KNOWN_FILES: readonly MemoryFileName[] = FLAT_FILES;

async function showAll(memory: MemoryStore): Promise<void> {
  for (const name of KNOWN_FILES) {
    const content = (await memory.read(name)) ?? "";
    const words = memory.countWords(content);
    const cap = memory.capFor(name);
    output.write(`${name.padEnd(14)} ${String(words).padStart(4)}/${cap}\n`);
  }
  output.write(
    `AGENTS.md      (per-repo, cap ${memory.capFor({ kind: "AGENTS", repo: "_" })}/repo)\n`,
  );
}

async function showOne(memory: MemoryStore, file: MemoryFile): Promise<void> {
  const content = await memory.read(file);
  if (content === undefined) {
    output.write(`(${fileLabel(file)} is empty)\n`);
    return;
  }
  output.write(content);
  if (!content.endsWith("\n")) output.write("\n");
}

export async function handleMemoryCommand(memory: MemoryStore, argv: string[]): Promise<void> {
  const sub = argv[0] ?? "list";
  if (sub === "list") {
    await showAll(memory);
    return;
  }
  if (sub === "show") {
    const fileArg = argv[1];
    if (!fileArg) {
      output.write("usage: /memory show <FILE.md> [repo]\n");
      return;
    }
    if (fileArg === "AGENTS.md") {
      const repo = argv[2];
      if (!repo) {
        output.write("/memory show AGENTS.md <repo>\n");
        return;
      }
      await showOne(memory, { kind: "AGENTS", repo });
      return;
    }
    if (!(KNOWN_FILES as readonly string[]).includes(fileArg)) {
      output.write(`unknown memory file: ${fileArg}\n`);
      return;
    }
    await showOne(memory, fileArg as MemoryFileName);
    return;
  }
  output.write("usage: /memory list | /memory show <FILE.md> [repo]\n");
}
