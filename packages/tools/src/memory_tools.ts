import type { ToolDefinition } from "@atenea/core";
import { FLAT_FILES, type MemoryFile, type MemoryFileName } from "@atenea/memory";
import { auditCall } from "./audit.js";

const FILE_ENUM: readonly string[] = [...FLAT_FILES, "AGENTS.md"];

function parseFile(input: unknown): MemoryFile {
  const i = input as { file?: unknown; repo?: unknown };
  if (typeof i.file !== "string" || !FILE_ENUM.includes(i.file)) {
    throw new Error(`memory: 'file' must be one of ${FILE_ENUM.join(", ")}`);
  }
  if (i.file === "AGENTS.md") {
    if (typeof i.repo !== "string" || i.repo.length === 0) {
      throw new Error("memory: 'repo' is required when file is AGENTS.md");
    }
    return { kind: "AGENTS", repo: i.repo };
  }
  return i.file as MemoryFileName;
}

const FILE_SCHEMA = {
  type: "string",
  enum: [...FILE_ENUM],
};

export const memoryReadTool: ToolDefinition = {
  name: "memory_read",
  description:
    "Read a memory file (SOUL.md, USER.md, MEMORY.md, SKILLS.md, LESSONS.md, AGENTS.md). For AGENTS.md, also pass 'repo'.",
  classification: "read_parallel",
  inputSchema: {
    type: "object",
    properties: {
      file: FILE_SCHEMA,
      repo: { type: "string", description: "Required iff file == AGENTS.md" },
    },
    required: ["file"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!ctx.memory) throw new Error("memory_read: memory store not configured");
    const file = parseFile(input);
    const content = await ctx.memory.read(file);
    auditCall(ctx, "memory_read", input, "ok");
    return content ?? "(empty)";
  },
};

export const memoryWriteTool: ToolDefinition = {
  name: "memory_write",
  description:
    "Write a memory file. Subject to per-file word caps; if over cap and a compactor is wired, content is rewritten down to 90% of cap, otherwise the write is refused. Returns a JSON outcome the model can inspect.",
  classification: "mutate_serial",
  inputSchema: {
    type: "object",
    properties: {
      file: FILE_SCHEMA,
      repo: { type: "string", description: "Required iff file == AGENTS.md" },
      content: { type: "string", description: "Full new file contents" },
    },
    required: ["file", "content"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!ctx.memory) throw new Error("memory_write: memory store not configured");
    const i = input as { content?: unknown };
    if (typeof i.content !== "string") throw new Error("memory_write: 'content' must be a string");
    const file = parseFile(input);
    const outcome = (await ctx.memory.write(file, i.content)) as
      | { kind: "written" | "compacted" }
      | { kind: "refused"; message: string };
    const auditOutcome = outcome.kind === "refused" ? "denied" : "ok";
    const auditMsg = outcome.kind === "refused" ? outcome.message : undefined;
    auditCall(ctx, "memory_write", input, auditOutcome, auditMsg);
    return JSON.stringify(outcome);
  },
};
