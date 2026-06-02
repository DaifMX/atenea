# cli-integration

## Purpose

Hook the phase-2 building blocks into the existing CLI: open the SQLite
state database at startup, build the memory store and approval gate,
register the phase-2 tools, render the approval prompt over readline, and
add the two new slash commands `/memory` and `/approvals`.

## Public surface

This domain produces no exported package symbols; it is purely the CLI
wiring under `packages/cli/src/`. New files:

- `packages/cli/src/state.ts` — resolves `ATENEA_HOME` and opens `state.db`.
- `packages/cli/src/approval_prompt.ts` — readline-based
  `ApprovalPrompter` implementation.
- `packages/cli/src/slash_memory.ts` — handles `/memory list`,
  `/memory show <file>`.
- `packages/cli/src/slash_approvals.ts` — handles `/approvals` (tail the
  last N rows).

Modified:

- `packages/cli/src/index.ts` — startup wiring.
- `packages/cli/src/repl.ts` — dispatch new slash commands; handle
  `AbortApprovalError` from the turn loop.
- `packages/cli/src/args.ts` — extend `printUsage()`.

## Startup flow (the only correct order)

```
parseArgs
 → resolveConfigPath
 → loadConfig
 → resolveAteneaHome(env, args, cfg)
 → openStateDb({ ateneaHome })
 → stateDb.startSession({ providerId, cwd })   // captures sessionId
 → createProvider(providerConfig)
 → createMemoryStore({ memoryDir, compactor, stateDb, sessionId })
 → createApprovalGate({ prompter, stateDb, sessionId })
 → ToolRegistry: registerPhase0Tools + registerPhase2Tools
 → ToolContext = { cwd, memory, approval, stateDb, sessionId }
 → runRepl(...)
```

`ATENEA_HOME` resolution order:

1. `--atenea-home <path>` CLI flag (new).
2. `ATENEA_HOME` env var.
3. `<configDir>/.atenea/` (created if missing).

## Approval prompter UX

When the gate calls `prompt(req)`, the prompter:

1. Releases the readline prompt (`rl.pause()`).
2. Writes the preview block:
   ```
   ── approval requested: fs_edit packages/cli/src/index.ts ──
   <unified diff>
   ── y apply / n skip / a always-this-file / q abort ──
   ```
3. Reads one keypress (raw mode), maps it to `ApprovalDecision`.
4. Resumes readline.

Invalid keys re-prompt. EOF on stdin → treated as `deny`.

## Slash commands

- `/memory list` → prints each `MemoryFile` with `<words>/<cap>`. Uses
  `MemoryStore.read` + `countWords`.
- `/memory show <file>` → prints the file contents (or `(empty)`).
- `/approvals` → reads the last 20 rows of `approvals` for the current
  session and prints them as a table.
- Existing commands (`/help`, `/exit`, `/clear`) continue to work.
- Unknown slash commands print a one-line error.

## Inputs / outputs / invariants

- The CLI **always** opens `state.db`. If opening fails (permission, disk
  full), the process exits with a clear message; the agent does not start
  with no audit trail.
- On clean exit (`/exit`, EOF), the CLI calls `stateDb.endSession` then
  `stateDb.close`.
- The compactor handed to the memory store is the
  `defaultCompactor(provider, baseSystem)` built in
  [memory-writer](./memory-writer.md). If the user is offline / provider
  errors during compaction, `memory_write` returns
  `{ kind: 'refused', reason: 'compactor_failed' }` — never silent loss.
- The approval prompt path always runs on the same readline interface, so
  no two prompts can ever race.

## Dependencies

- [state-db](./state-db.md)
- [memory-writer](./memory-writer.md)
- [approval-gate](./approval-gate.md)
- [mutation-tools](./mutation-tools.md)

## Step-by-step implementation plan

1. Add `--atenea-home` arg parsing to `args.ts`; extend `CliArgs`.
2. Implement `state.ts` (`resolveAteneaHome`, `openSession`).
3. Implement `approval_prompt.ts`. Use Node `readline`'s
   `process.stdin.once('keypress', ...)` after `readline.emitKeypressEvents`.
4. Implement `slash_memory.ts` and `slash_approvals.ts`.
5. Update `index.ts` to chain the startup flow above.
6. Update `repl.ts` to route `/memory ...` and `/approvals` and to catch
   `AbortApprovalError` returned by `runTurn`.
7. Update `printUsage()` to document the new flag and the new commands.

## Acceptance criteria

- Starting the CLI in a fresh directory creates
  `<configDir>/.atenea/state.db` and inserts a `sessions` row.
- Running `/memory list` after a fresh checkout prints six lines, each
  showing `0/<cap>` (or `SOUL.md` showing its current word count).
- A turn that produces an `fs_write` tool call against `README.md`
  triggers an approval prompt; pressing `n` records a denial row and the
  model continues without modifying the file.
- Pressing `q` at the prompt aborts the turn cleanly; the REPL stays open.
- Pressing Ctrl-D at the prompt closes the REPL, which ends the session
  in SQL and closes the DB handle.

## Out of scope

- A graphical TUI; phase 5 owns that. Readline is the floor.
- Configurable keybindings. `y/n/a/q` are fixed in phase 2.
- Streaming the approval preview through pagers for very large diffs;
  rely on terminal scrollback for now.
