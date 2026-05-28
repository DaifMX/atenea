import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve, relative } from "node:path";
import type { ToolDefinition } from "@atenea/core";

const MAX_BYTES = 256 * 1024; // 256 KB hard cap per read

function resolveSafe(cwd: string, path: string): string {
  const abs = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const rel = relative(cwd, abs);
  if (rel.startsWith("..")) {
    throw new Error(`path '${path}' escapes the working directory`);
  }
  return abs;
}

export const fsReadTool: ToolDefinition = {
  name: "fs_read",
  description:
    "Read a UTF-8 text file. Optionally specify start_line (1-indexed, inclusive) and end_line. Paths are resolved relative to the agent's working directory; absolute paths must stay inside it.",
  classification: "read_parallel",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read" },
      start_line: { type: "integer", minimum: 1, description: "1-indexed start line (inclusive)" },
      end_line: { type: "integer", minimum: 1, description: "1-indexed end line (inclusive)" },
    },
    required: ["path"],
    additionalProperties: false,
  },

  async execute(input, ctx) {
    const i = input as { path?: unknown; start_line?: unknown; end_line?: unknown };

    if (typeof i.path !== "string") throw new Error("fs_read: 'path' must be a string");

    const abs = resolveSafe(ctx.cwd, i.path);

    const st = await stat(abs);

    if (!st.isFile()) throw new Error(`fs_read: '${i.path}' is not a regular file`);
    if (st.size > MAX_BYTES) {
      throw new Error(
        `fs_read: '${i.path}' is ${st.size} bytes (cap ${MAX_BYTES}); narrow with start_line/end_line or use rg`,
      );
    }

    const text = await readFile(abs, "utf8");
    const start = typeof i.start_line === "number" ? i.start_line : undefined;
    const end = typeof i.end_line === "number" ? i.end_line : undefined;

    if (start === undefined && end === undefined) {
      return numberLines(text, 1);
    }

    const lines = text.split("\n");

    const s = Math.max(1, start ?? 1);
    const e = Math.min(lines.length, end ?? lines.length);

    if (e < s) throw new Error(`fs_read: end_line (${e}) precedes start_line (${s})`);
    return numberLines(lines.slice(s - 1, e).join("\n"), s);
  },
};

function numberLines(text: string, startLineNo: number): string {
  return text
    .split("\n")
    .map((line, i) => `${String(startLineNo + i).padStart(5, " ")}\t${line}`)
    .join("\n");
}
