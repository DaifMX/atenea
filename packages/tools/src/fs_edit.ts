import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition } from "@atenea/core";
import { resolveSafe } from "./path_safety.js";
import { unifiedDiff } from "./diff.js";
import { auditCall } from "./audit.js";

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  while (true) {
    const next = haystack.indexOf(needle, i);
    if (next === -1) return count;
    count++;
    i = next + needle.length;
  }
}

export const fsEditTool: ToolDefinition = {
  name: "fs_edit",
  description:
    "Replace a specific string in a file inside the working directory. Requires per-edit approval. By default old_string must be unique; set replace_all=true to substitute every occurrence.",
  classification: "mutate_serial",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean", default: false },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!ctx.approval) throw new Error("fs_edit: approval gate not configured");

    const i = input as {
      path?: unknown;
      old_string?: unknown;
      new_string?: unknown;
      replace_all?: unknown;
    };
    if (typeof i.path !== "string") throw new Error("fs_edit: 'path' must be a string");
    if (typeof i.old_string !== "string") throw new Error("fs_edit: 'old_string' must be a string");
    if (typeof i.new_string !== "string") throw new Error("fs_edit: 'new_string' must be a string");
    const replaceAll = i.replace_all === true;

    const block = ctx.approval.isHardBlocked("fs_edit", { path: i.path });
    if (block.blocked) {
      auditCall(ctx, "fs_edit", { path: i.path }, "blocked", block.reason);
      return `fs_edit blocked: ${block.reason}`;
    }

    const abs = resolveSafe(ctx.cwd, i.path);
    const before = await readFile(abs, "utf8");

    const occ = countOccurrences(before, i.old_string);
    if (occ === 0) {
      throw new Error(`fs_edit: 'old_string' not found in ${i.path}`);
    }
    if (occ > 1 && !replaceAll) {
      throw new Error(
        `fs_edit: 'old_string' matches ${occ} times in ${i.path}; pass replace_all=true to replace all`,
      );
    }

    const after = replaceAll
      ? before.split(i.old_string).join(i.new_string)
      : before.replace(i.old_string, i.new_string);

    if (after === before) {
      return `fs_edit: no-op on ${i.path}`;
    }

    const diff = unifiedDiff(before, after, i.path);
    const decision = await ctx.approval.request({
      toolName: "fs_edit",
      targetPath: i.path,
      preview: diff,
      summary: `edit ${i.path}${replaceAll ? ` (×${occ})` : ""}`,
    });

    if (decision.kind === "deny") {
      const reason = decision.reason ?? "denied by user";
      auditCall(ctx, "fs_edit", { path: i.path }, "denied", reason);
      return `fs_edit denied: ${reason}`;
    }

    await writeAtomic(abs, after);
    auditCall(ctx, "fs_edit", { path: i.path }, "ok");
    return `edited ${i.path}`;
  },
};
