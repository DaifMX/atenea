# state-db

## Purpose

`state.db` is the embedded SQLite database that holds **precious, slow-changing
state** for the agent process: which session is currently running, every
approval/denial the user has issued, the full audit log of mutating tool calls,
and the journal of memory compactions. It is intentionally separate from any
rebuildable artifacts (the indexer, embeddings, summary cache) so it can be
backed up cheaply. It lives at `${ATENEA_HOME}/state.db` (default
`./.atenea/state.db` on bare metal, `/data/state.db` inside the container).

## Public surface

Exported from a new workspace package `@atenea/state`:

```ts
export interface StateDb {
  readonly path: string;
  // sessions
  startSession(meta: { providerId: string; cwd: string }): SessionRow;
  endSession(id: number, summary?: string): void;
  // approvals
  recordApproval(input: ApprovalInput): ApprovalRow;
  // audit
  recordToolCall(input: ToolCallAuditInput): ToolCallRow;
  // memory compactions
  recordCompaction(input: CompactionInput): CompactionRow;
  // bookkeeping
  close(): void;
}

export interface OpenStateDbOpts {
  ateneaHome: string;       // resolved from env or config
  migrate?: boolean;        // default true
}

export function openStateDb(opts: OpenStateDbOpts): StateDb;
```

Row/input types are exported alongside. All writes are synchronous (the
underlying driver is `better-sqlite3`).

## Schema

All tables WAL-journalled. Created on first open if missing; later phases
add migrations.

```sql
CREATE TABLE sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT    NOT NULL,            -- ISO-8601 UTC
  ended_at     TEXT,
  provider_id  TEXT    NOT NULL,
  cwd          TEXT    NOT NULL,
  summary      TEXT
);

CREATE TABLE approvals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  recorded_at   TEXT    NOT NULL,
  tool_name     TEXT    NOT NULL,
  target_path   TEXT,                       -- nullable: not every mutation is path-scoped
  decision      TEXT    NOT NULL CHECK (decision IN ('allow','deny','always_file')),
  preview_hash  TEXT    NOT NULL,           -- sha256 of the diff/command preview
  preview       TEXT    NOT NULL            -- the actual preview shown
);
CREATE INDEX approvals_session_idx ON approvals(session_id, recorded_at);

CREATE TABLE tool_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  called_at     TEXT    NOT NULL,
  tool_name     TEXT    NOT NULL,
  input_json    TEXT    NOT NULL,
  outcome       TEXT    NOT NULL CHECK (outcome IN ('ok','blocked','denied','error')),
  message       TEXT
);
CREATE INDEX tool_audit_session_idx ON tool_audit(session_id, called_at);

CREATE TABLE memory_compactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  recorded_at   TEXT    NOT NULL,
  file          TEXT    NOT NULL,           -- e.g. memory/SKILLS.md
  cap_words     INTEGER NOT NULL,
  before_words  INTEGER NOT NULL,
  after_words   INTEGER NOT NULL,
  before_text   TEXT    NOT NULL,
  after_text    TEXT    NOT NULL
);
```

## Inputs / outputs / invariants

- The DB file is opened with `journal_mode = WAL` and `synchronous = NORMAL`.
- One `StateDb` instance per agent process. Not safe to share across processes
  without lock coordination — phase 2 is single-process.
- `recordApproval` and `recordToolCall` are append-only; never updated.
- A `decision = 'always_file'` row implies the gate has cached the
  always-allow status for that `(tool_name, target_path)` for the current
  session; the cache is in-memory, the row is the audit trail.
- The `previous_text` stored on a compaction is the **full file** before
  compaction. We accept the size overhead; the markdown caps are small.
- `close()` is idempotent.

## Dependencies

- `better-sqlite3` (new runtime dep)
- No other ATENEA packages; this is the bottom of the dep graph.

## Step-by-step implementation plan

1. Create `packages/state/` with the usual workspace boilerplate (mirrors
   `packages/config/`).
2. Add `better-sqlite3` and `@types/better-sqlite3` deps.
3. Define `OpenStateDbOpts`, `StateDb`, all input/row types in
   `src/types.ts`.
4. Write `src/migrations.ts` that issues the four `CREATE TABLE` statements
   inside a single transaction. Use `PRAGMA user_version` to detect first
   run; later phases bump the version.
5. Write `src/index.ts` exporting `openStateDb`. Implementation wraps each
   public method in a prepared statement; converts `Date` → ISO string at
   the boundary; converts row strings back to typed values when needed.
6. Export everything from `packages/state/src/index.ts`.
7. Add the new package to `packages/config` and `packages/cli` deps so the
   CLI can open it at startup.

## Acceptance criteria

- `openStateDb({ ateneaHome })` creates the file + schema if absent and
  returns a working handle. Re-opening an existing DB is a no-op for the
  schema.
- After `startSession` followed by `recordApproval`, `recordToolCall`, and
  `recordCompaction`, `sqlite3 state.db "select count(*) from <table>"`
  returns `1` for each.
- Closing and reopening the DB preserves all rows.
- Passing an `ateneaHome` directory that does not exist creates it before
  opening (parents included).

## Out of scope

- Migrations beyond the initial create. Future phases own this.
- Cross-process locking; phase 2 is one CLI = one process.
- Encryption at rest. We rely on filesystem permissions for now.
- Any GUI to inspect approvals. The `/approvals` slash command in
  [cli-integration](./cli-integration.md) gives a text dump only.
