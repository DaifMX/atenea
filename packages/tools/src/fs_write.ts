import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition } from "@atenea/core";
import { resolveSafe } from "./path_safety.js";
import { unifiedDiff } from "./diff.js";
import { auditCall } from "./audit.js";

const MAX_BYTES = 256 * 1024;

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

export const fsWriteTool: ToolDefinition = {
  name: "fs_write",
  description:
    "Write a UTF-8 text file inside the working directory. Requires per-edit approval. Set overwrite=true if the file already exists.",
  classification: "mutate_serial",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Target path, resolved inside cwd" },
      content: { type: "string", description: "Full new file contents" },
      overwrite: {
        type: "boolean",
        description: "Must be true to overwrite an existing file",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!ctx.approval) throw new Error("fs_write: approval gate not configured");

    const i = input as { path?: unknown; content?: unknown; overwrite?: unknown };
    if (typeof i.path !== "string") throw new Error("fs_write: 'path' must be a string");
    if (typeof i.content !== "string") throw new Error("fs_write: 'content' must be a string");

    const block = ctx.approval.isHardBlocked("fs_write", { path: i.path });
    if (block.blocked) {
      const msg = `fs_write blocked: ${block.reason}`;
      auditCall(ctx, "fs_write", { path: i.path }, "blocked", block.reason);
      return msg;
    }

    const abs = resolveSafe(ctx.cwd, i.path);

    if (Buffer.byteLength(i.content, "utf8") > MAX_BYTES) {
      throw new Error(
        `fs_write: content is over ${MAX_BYTES} bytes; split the write or use fs_edit`,
      );
    }

    const existed = await fileExists(abs);
    if (existed && i.overwrite !== true) {
      throw new Error(`fs_write: '${i.path}' already exists; pass overwrite=true`);
    }

    const before = existed ? await readIfExists(abs) : "";
    const diff = unifiedDiff(before, i.content, i.path);

    const decision = await ctx.approval.request({
      toolName: "fs_write",
      targetPath: i.path,
      preview: diff,
      summary: existed ? `overwrite ${i.path}` : `create ${i.path}`,
    });

    if (decision.kind === "deny") {
      const reason = decision.reason ?? "denied by user";
      auditCall(ctx, "fs_write", { path: i.path }, "denied", reason);
      return `fs_write denied: ${reason}`;
    }

    await writeAtomic(abs, i.content);
    auditCall(ctx, "fs_write", { path: i.path }, "ok");
    return existed ? `overwrote ${i.path}` : `wrote ${i.path}`;
  },
};
