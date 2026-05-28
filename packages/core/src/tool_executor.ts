import type { ToolUsePart, ToolResultPart } from "@atenea/providers";
import type { ToolContext, ToolRegistry } from "./tool.js";

const MAX_PARALLEL = 8;

export interface ExecutorOptions {
  registry: ToolRegistry;
  ctx: ToolContext;
}

// Truncate massive tool outputs so they don't blow context. Phase 2 will
// stream large outputs to disk and return a pointer instead.
const MAX_RESULT_CHARS = 20_000;

function truncate(s: string): { content: string; truncated: boolean } {
  if (s.length <= MAX_RESULT_CHARS) return { content: s, truncated: false };
  const head = s.slice(0, MAX_RESULT_CHARS);
  return {
    content: `${head}\n\n[…truncated, ${s.length - MAX_RESULT_CHARS} chars omitted]`,
    truncated: true,
  };
}

async function runOne(call: ToolUsePart, opts: ExecutorOptions): Promise<ToolResultPart> {
  const def = opts.registry.get(call.name);
  if (!def) {
    return {
      type: "tool_result",
      toolUseId: call.id,
      content: `Unknown tool: ${call.name}`,
      isError: true,
    };
  }
  try {
    const raw = await def.execute(call.input, opts.ctx);
    const { content } = truncate(raw);
    return { type: "tool_result", toolUseId: call.id, content };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { type: "tool_result", toolUseId: call.id, content: msg, isError: true };
  }
}

// Splits calls into parallel-safe batch (all read_parallel at the front)
// and a serial tail (anything mutate_serial). Within the parallel batch we
// cap concurrency at MAX_PARALLEL. Order of returned results matches input.
export async function executeToolCalls(
  calls: ToolUsePart[],
  opts: ExecutorOptions,
): Promise<ToolResultPart[]> {
  const results: ToolResultPart[] = new Array(calls.length);
  const parallelIdx: number[] = [];
  const serialIdx: number[] = [];

  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (!c) continue;
    const def = opts.registry.get(c.name);
    if (def?.classification === "read_parallel") parallelIdx.push(i);
    else serialIdx.push(i);
  }

  // Parallel batch with bounded concurrency.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_PARALLEL, parallelIdx.length) }, async () => {
    while (cursor < parallelIdx.length) {
      const myIdx = cursor++;
      const idx = parallelIdx[myIdx];
      if (idx === undefined) return;
      const call = calls[idx];
      if (!call) continue;
      results[idx] = await runOne(call, opts);
    }
  });
  await Promise.all(workers);

  // Serial tail.
  for (const idx of serialIdx) {
    const call = calls[idx];
    if (!call) continue;
    results[idx] = await runOne(call, opts);
  }

  return results;
}
