# mutation-tools

## Purpose

This domain ships the four tools that compose the lower layers built in
phase 2. They are the **first** mutating capabilities the agent has, and
they exist precisely to validate the [approval-gate](./approval-gate.md)
and [memory-writer](./memory-writer.md) end-to-end.

| Tool          | Classification    | Routes through                          |
| ------------- | ----------------- | --------------------------------------- |
| `fs_write`    | `mutate_serial`   | approval-gate                           |
| `fs_edit`     | `mutate_serial`   | approval-gate                           |
| `memory_read` | `read_parallel`   | nothing (read-only)                     |
| `memory_write`| `mutate_serial`   | memory-writer (which gates internally)  |

No other mutation tools land in phase 2. `terminal`, `git_*`,
`index.search`, and `summary.get` are explicitly deferred.

## Public surface

Exported from `@atenea/tools`:

```ts
export const fsWriteTool: ToolDefinition;
export const fsEditTool: ToolDefinition;
export const memoryReadTool: ToolDefinition;
export const memoryWriteTool: ToolDefinition;

export interface Phase2RegistryDeps {
  memory: MemoryStore;
  approval: ApprovalGate;
  stateDb: StateDb;
  sessionId: number;
}

export function registerPhase2Tools(
  registry: ToolRegistry,
  deps: Phase2RegistryDeps,
): void;
```

`registerPhase2Tools` is additive on top of `registerPhase0Tools`; it does
not register or remove anything from the phase-0 set.

## Tool contracts

### `fs_write`

Input schema:

```jsonc
{
  "type": "object",
  "properties": {
    "path":    { "type": "string", "description": "Target path, must resolve inside cwd" },
    "content": { "type": "string" },
    "overwrite": { "type": "boolean", "description": "Required true when the file already exists" }
  },
  "required": ["path", "content"],
  "additionalProperties": false
}
```

Behaviour:

1. Resolve `path` safely against `ctx.cwd` (reusing the same helper as
   `fs_read`).
2. Refuse hard-blocks (`.git/`, anything in `DEFAULT_HARD_BLOCKS` matching
   this tool).
3. Compute a unified diff against the current file (empty file if it
   doesn't exist) using a minimal pure-TS diff so we avoid a runtime dep.
4. Call `ctx.approval.request({ toolName: 'fs_write', targetPath: path, preview: diff })`.
5. On `allow` / `allow_always_file`, write atomically (`tmp + rename`) and
   record a `tool_audit` row with `outcome = 'ok'`.
6. On `deny`, return a `tool_result` reporting denial; record audit with
   `outcome = 'denied'`.

### `fs_edit`

A targeted string replacement, mirroring the user-side `Edit` tool but
gated:

```jsonc
{
  "type": "object",
  "properties": {
    "path":        { "type": "string" },
    "old_string":  { "type": "string" },
    "new_string":  { "type": "string" },
    "replace_all": { "type": "boolean", "default": false }
  },
  "required": ["path", "old_string", "new_string"],
  "additionalProperties": false
}
```

Behaviour: read the file, refuse if `old_string` is not present, refuse if
`replace_all = false` and `old_string` appears more than once, build a
unified diff, request approval, write atomically.

### `memory_read`

```jsonc
{
  "type": "object",
  "properties": {
    "file": { "type": "string", "enum": ["SOUL.md","USER.md","MEMORY.md","SKILLS.md","LESSONS.md","AGENTS.md"] },
    "repo": { "type": "string", "description": "Required iff file == AGENTS.md" }
  },
  "required": ["file"],
  "additionalProperties": false
}
```

Returns the raw file contents, or the literal string `"(empty)"` if the
file does not exist. Read-only, parallel-safe, no approval.

### `memory_write`

Same input schema as `memory_read`, plus a `content` field. The tool does
**not** call the approval gate; the gating it needs is the cap-enforcing
writer + the compactor confirmation, which is enforced by
[memory-writer](./memory-writer.md). Mutations to memory are not edits to
the working tree, so the diff-approval UX is not the right primitive
here. We still audit the call.

Returns a JSON-stringified `WriteOutcome` so the model can react when its
write was refused or compacted.

## Inputs / outputs / invariants

- Every mutation tool writes exactly one `tool_audit` row.
- A tool that the gate denied or the writer refused **does not throw** —
  it returns a `tool_result` with `isError: true` and an explanatory
  message, so the model can either retry or move on.
- `AbortApprovalError` from the gate is allowed to propagate; the executor
  catches it.

## Dependencies

- [approval-gate](./approval-gate.md)
- [memory-writer](./memory-writer.md)
- [state-db](./state-db.md)
- `@atenea/core` `ToolDefinition` / `ToolContext`.

## Step-by-step implementation plan

1. Create `packages/tools/src/diff.ts` with a tiny unified-diff renderer
   (line-level, no fancy heuristics). Pure function: `diff(oldText,
   newText, path) → string`.
2. Implement `fs_write.ts`, `fs_edit.ts`, `memory_read.ts`,
   `memory_write.ts`.
3. Add a path-safety helper shared with `fs_read.ts` (extract it from
   `fs_read.ts` if needed).
4. Extend `ToolContext` consumers in those files to read `ctx.approval`,
   `ctx.memory`, `ctx.stateDb`, `ctx.sessionId`. (The first three become
   optional fields on `ToolContext`; the tools throw a clear message if
   absent, which the CLI prevents.)
5. Export `registerPhase2Tools` from `packages/tools/src/index.ts`.
6. Audit every tool call in a single helper `auditCall(ctx, name, input,
   outcome, msg?)`.

## Acceptance criteria

- Calling `fs_write` with a stub gate returning `allow` writes the file
  and produces one `tool_audit` row with `outcome = 'ok'`.
- Calling `fs_write` against `.git/HEAD` returns an error result without
  prompting and records `outcome = 'blocked'`.
- Calling `fs_edit` with an `old_string` not present in the file returns
  an error result, no prompt, no mutation.
- `memory_read` against a missing file returns `(empty)`.
- `memory_write` against `SOUL.md` with 410 words (cap 400) returns a
  tool-result whose JSON payload has `kind: 'refused'`.

## Out of scope

- Streaming/large-file edits. Both tools are capped at 256 KB input.
- Multi-file atomic mutations. Each tool call is one file.
- Patch-format inputs (apply a `*.patch`); not needed yet.
