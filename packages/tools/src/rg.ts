import { spawn } from "node:child_process";
import { isAbsolute, resolve, relative } from "node:path";
import type { ToolDefinition } from "@atenea/core";

const MAX_OUTPUT_BYTES = 256 * 1024;

function resolveSafe(cwd: string, path: string): string {
  const abs = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const rel = relative(cwd, abs);
  if (rel.startsWith("..")) {
    throw new Error(`path '${path}' escapes the working directory`);
  }
  return abs;
}

export const rgTool: ToolDefinition = {
  name: "rg",
  description:
    "Search the working directory with ripgrep. Returns matches as 'path:line:col:text'. Use a precise regex; results are capped.",
  classification: "read_parallel",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Subdirectory or file to search within (optional)" },
      glob: { type: "string", description: "Path glob filter, e.g. '*.ts'" },
      case_insensitive: { type: "boolean" },
      max_count: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description: "Max matches per file (default 50)",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const i = input as {
      pattern?: unknown;
      path?: unknown;
      glob?: unknown;
      case_insensitive?: unknown;
      max_count?: unknown;
    };
    if (typeof i.pattern !== "string" || i.pattern.length === 0) {
      throw new Error("rg: 'pattern' must be a non-empty string");
    }

    const args = ["--color=never", "--line-number", "--column", "--no-heading", "--with-filename"];
    if (i.case_insensitive === true) args.push("-i");
    const maxCount =
      typeof i.max_count === "number" && i.max_count > 0 ? Math.floor(i.max_count) : 50;
    args.push(`--max-count=${maxCount}`);
    if (typeof i.glob === "string" && i.glob.length > 0) args.push("--glob", i.glob);

    args.push("--", i.pattern);
    // rg with no path argument reads from stdin — explicitly default to cwd.
    const searchPath =
      typeof i.path === "string" && i.path.length > 0
        ? resolveSafe(ctx.cwd, i.path)
        : ctx.cwd;
    args.push(searchPath);

    return await runRg(args, ctx.cwd, ctx.signal);
  },
};

function runRg(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const spawnOpts: { cwd: string; signal?: AbortSignal } = { cwd };
    if (signal) spawnOpts.signal = signal;
    const proc = spawn("rg", args, spawnOpts);
    let out = "";
    let err = "";
    let truncated = false;
    proc.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      out += chunk.toString("utf8");
      if (out.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        out = out.slice(0, MAX_OUTPUT_BYTES);
        proc.kill();
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    proc.on("error", (e) => rejectPromise(new Error(`rg failed to start: ${e.message}`)));
    proc.on("close", (code) => {
      // rg exit codes: 0 match, 1 no match, 2 error
      if (code === 0 || code === 1 || (truncated && code === null)) {
        const body = out || "(no matches)";
        const suffix = truncated ? "\n\n[…output truncated]" : "";
        resolvePromise(body + suffix);
      } else {
        rejectPromise(new Error(`rg exited with code ${code}: ${err.trim()}`));
      }
    });
  });
}
