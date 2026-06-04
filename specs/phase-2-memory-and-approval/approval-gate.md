# approval-gate

## Purpose

The approval gate is the middleware that every mutating tool **must** call
before touching the working tree or any external state. It renders a
diff/command preview, asks the user to choose one of `y / n / a / q`, caches
"always" decisions for the rest of the session, hard-blocks a small list of
dangerous tool names, and audits every decision to [state-db](./state-db.md).

This is the load-bearing safety guarantee from the SOUL: "I never modify code
that the user has not explicitly authorized."

## Public surface

Exported from `@atenea/core`:

```ts
export interface ApprovalRequest {
  toolName: string;
  targetPath?: string;       // e.g. the file being edited; used for "always_file"
  preview: string;           // the diff or command that the user is asked to authorize
  summary?: string;          // one-line label shown above the preview
}

export type ApprovalDecision =
  | { kind: "allow" }
  | { kind: "allow_always_file" }
  | { kind: "deny"; reason?: string }
  | { kind: "abort" };       // q — stops the entire turn

export interface ApprovalPrompter {
  // Implementations live in the CLI (readline) or future TUI.
  prompt(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface ApprovalGateOpts {
  prompter: ApprovalPrompter;
  stateDb: StateDb;
  sessionId: number;
  // Default hard-block patterns; mutation tools may also self-block.
  hardBlocks?: HardBlockRule[];
}

export interface HardBlockRule {
  // Matches a tool call. Either an exact tool name, or a (toolName, predicate)
  // pair that inspects the input. Used for "git terminal command contains push".
  toolName: string;
  reject?: (input: unknown) => boolean;
  reason: string;
}

export const DEFAULT_HARD_BLOCKS: HardBlockRule[];

export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
  isHardBlocked(toolName: string, input: unknown): { blocked: true; reason: string } | { blocked: false };
}

export function createApprovalGate(opts: ApprovalGateOpts): ApprovalGate;

// AbortApprovalError is thrown when the user chose `q`; the runTurn loop
// catches it and stops the iteration early.
export class AbortApprovalError extends Error {}
```

## Inputs / outputs / invariants

- **Decision flow** (in order):
  1. Check `isHardBlocked` — if yes, **the mutation tool refuses without
     even calling `request`**, and an audit row with `outcome = 'blocked'`
     is written by the tool itself.
  2. Otherwise, consult the in-memory "always-file" cache keyed by
     `(toolName, targetPath)`. Cache hit → return `allow`, no prompt.
  3. Otherwise, call `prompter.prompt(req)`.
  4. Persist the decision to `state.db.approvals`.
  5. If `allow_always_file`, insert into the cache and persist with
     `decision = 'always_file'`.
  6. If `abort`, throw `AbortApprovalError`.
- **Idempotence.** The same `(toolName, targetPath, previewHash)` may be
  requested multiple times in one turn (model retries); each request gets a
  fresh prompt unless `always_file` is cached.
- **`previewHash`** = sha256 of `preview`. Recorded so we can detect
  "the user approved a different diff than the one we then applied."
- **Hard-blocks are unconditional.** Even if the prompter is replaced with
  an auto-allow stub for testing, hard-blocks still fire.

## Default hard-blocks (must ship)

| Tool          | Predicate                                                | Reason                            |
| ------------- | -------------------------------------------------------- | --------------------------------- |
| `git_commit`  | always                                                   | "use /commit; agent cannot commit" |
| `git_push`    | always                                                   | "agent cannot push"                |
| `terminal`    | command matches `^git\s+(push\|commit\|reset --hard)`    | "blocked git verb"                 |
| `terminal`    | command contains `rm -rf` (whitespace-tolerant)          | "rm -rf is hard-blocked"           |
| `fs_write`    | path resolves to a `.git/` directory                     | "writing inside .git is blocked"   |
| `fs_edit`    | path resolves to a `.git/` directory                     | "editing inside .git is blocked"   |

Phase 2 ships no `terminal` or `git_*` tools, but the rules ship now so the
list is canonical and the indexer/phase-5 work can rely on it.

## Dependencies

- [state-db](./state-db.md) for the audit table.
- An `ApprovalPrompter` implementation lives in
  [cli-integration](./cli-integration.md).

## Step-by-step implementation plan

1. In `packages/core/src/approval.ts`, define types and
   `DEFAULT_HARD_BLOCKS`.
2. Implement `createApprovalGate` with the decision flow above.
3. Add the in-memory `Map<string, true>` cache keyed by
   `${toolName}\0${targetPath}`.
4. Add a `previewHash` helper (`createHash('sha256')`).
5. Export from `packages/core/src/index.ts`.
6. Extend `ToolContext` in `packages/core/src/tool.ts` with optional
   `approval?: ApprovalGate`. Existing read-only tools ignore it.
7. Update `tool_executor.ts` to catch `AbortApprovalError` and surface it
   as a `tool_result` with `isError: true` AND a side-channel signal to
   the loop to stop iterating.

## Acceptance criteria

- A `mutate_serial` tool that calls `ctx.approval.request(...)` with a
  prompter stubbed to return `allow` writes the change and records one
  `approvals` row.
- A second call for the same `(toolName, targetPath)` does NOT prompt
  after the user once chose `allow_always_file`. (Verifiable by counting
  prompter invocations.)
- A call to `git_push` is hard-blocked before the prompter is consulted;
  one `tool_audit` row with `outcome = 'blocked'`, zero `approvals` rows.
- Choosing `abort` aborts the turn: `runTurn` returns a result with
  `stopReason = 'error'` and `errorMessage` mentions the abort.

## Out of scope

- Multi-step approvals (e.g. "approve this set of 5 edits at once"). The
  gate is single-decision per request; batching is a TUI affordance for
  phase 5.
- Persistent "always-this-file" across sessions. The cache resets every
  CLI start by design.
- Time-limited or count-limited approvals. Future work if we feel pain.
