# memory-writer

## Purpose

The memory writer is the **only** path through which ATENEA mutates the six
markdown files in `memory/`. It enforces the per-file word-count caps from
INSTRUCTIONS.md §6, refuses oversized writes, and — when an LLM-backed
compactor is wired in — rewrites the file to ≤90% of the cap rather than
silently dropping content. Every compaction is journalled to
[state-db](./state-db.md) so it can be inspected or rolled back.

## Public surface

Exported from a new workspace package `@atenea/memory`:

```ts
export type MemoryFile =
  | "SOUL.md"
  | "USER.md"
  | "MEMORY.md"
  | "SKILLS.md"
  | "LESSONS.md"
  | { kind: "AGENTS"; repo: string }; // resolves to memory/agents/<repo>.md

export interface CapTable {
  "SOUL.md": number;     // 400
  "USER.md": number;     // 300
  "MEMORY.md": number;   // 600
  "AGENTS.md": number;   // 400 per repo
  "SKILLS.md": number;   // 800
  "LESSONS.md": number;  // 600
}

export const DEFAULT_CAPS: CapTable;

export interface Compactor {
  // Receives the proposed content and the target word count, returns a
  // rewritten file that MUST be ≤ targetWords. May throw on failure.
  compact(input: { file: string; text: string; targetWords: number }): Promise<string>;
}

export interface MemoryStoreOpts {
  memoryDir: string;
  caps?: Partial<CapTable>;
  compactor?: Compactor;     // if absent, overflow ⇒ refusal
  stateDb?: StateDb;         // optional but recommended; required for audit
  sessionId?: number;        // current session, for the audit row
}

export interface MemoryStore {
  read(file: MemoryFile): Promise<string | undefined>;
  write(file: MemoryFile, text: string): Promise<WriteOutcome>;
  capFor(file: MemoryFile): number;
  countWords(text: string): number;
}

export type WriteOutcome =
  | { kind: "written"; wordCount: number; cap: number }
  | { kind: "compacted"; wordCount: number; cap: number; droppedWords: number }
  | { kind: "refused"; reason: "over_cap_no_compactor" | "compactor_failed"; wordCount: number; cap: number; message: string };

export function createMemoryStore(opts: MemoryStoreOpts): MemoryStore;
```

## Inputs / outputs / invariants

- **Word counter.** A "word" is a maximal run of non-whitespace characters
  in the rendered Markdown, with code fences stripped first (we do not want
  large code blocks to lock out narrative space). Headings, list markers,
  and inline code count. Numbers and punctuation count as parts of the word
  they sit in. The counter is deterministic and pure.
- **Caps come from `DEFAULT_CAPS`**, overridable per-instance via
  `MemoryStoreOpts.caps`. For `AGENTS.md` the cap is **per repo file**, not
  global.
- **`read`** returns `undefined` if the file does not exist; never throws on
  ENOENT.
- **`write` happy path**: word count ≤ cap → write atomically (write to
  `<file>.tmp` then rename) → return `{ kind: "written" }`.
- **`write` overflow path with compactor**:
  1. Compute target = `floor(cap * 0.9)`.
  2. Call `compactor.compact({ file, text, targetWords: target })`.
  3. Verify the result fits under the cap. If not, refuse.
  4. Write atomically.
  5. Journal a `memory_compactions` row holding both the pre- and
     post-compaction text.
  6. Return `{ kind: "compacted" }`.
- **`write` overflow path without compactor**: return
  `{ kind: "refused", reason: "over_cap_no_compactor", ... }`. No file
  mutation, no audit row.
- **Atomicity invariant.** A failed compaction or a failed verify never
  leaves a partially written `.md` on disk.
- **No path escape.** `write({ kind: "AGENTS", repo })` resolves under
  `memory/agents/`; the writer rejects any `repo` that contains `..`, `/`,
  or a leading `.`.

## Dependencies

- [state-db](./state-db.md) for the compaction journal.
- A `Compactor` implementation. In phase 2 the CLI wires a provider-backed
  compactor (`@atenea/providers`) that asks the active LLM to rewrite the
  file. The store itself only sees the interface.

## Step-by-step implementation plan

1. Create `packages/memory/` workspace package.
2. Add deps: `@atenea/state` (workspace), no runtime deps beyond Node
   built-ins for the writer itself.
3. Implement `countWords(text)` in `src/word_count.ts`. Strip ``` fenced
   blocks first, then split on `/\s+/`, discard empty strings. Add a
   unit-style snapshot test in the spec under "Acceptance criteria".
4. Implement `src/paths.ts` resolving each `MemoryFile` variant to an
   absolute path. Validate `AGENTS` repo names.
5. Implement `createMemoryStore` in `src/index.ts`. Read/write helpers are
   `fs/promises`-based. The atomic write uses
   `writeFile(tmp) → rename(tmp, final)`.
6. Wire the compaction path: compute target, call `compactor.compact`,
   recount, verify, persist, journal.
7. Export the package from `packages/memory/src/index.ts`.
8. Add a thin `defaultCompactor(provider, system)` factory under
   `packages/memory/src/compactor.ts`. It builds a one-shot prompt
   instructing the LLM to preserve most-recently-relevant entries and
   produce ≤ `targetWords` words.

## Acceptance criteria

- `countWords("hello world  ")` = `2`. Triple-backtick fenced code is
  excluded: `countWords("a\n```\nlots of code\n```\nb")` = `2`.
- Writing 350 words to `USER.md` (cap 300) without a compactor returns
  `{ kind: "refused", reason: "over_cap_no_compactor" }` and leaves the
  file unchanged.
- Writing 350 words to `USER.md` with a stub compactor that returns 270
  words returns `{ kind: "compacted", droppedWords: 80 }` and records one
  `memory_compactions` row.
- If the compactor returns 320 words (still over cap), the outcome is
  `{ kind: "refused", reason: "compactor_failed" }`.
- `write({ kind: "AGENTS", repo: "../escape" }, ...)` throws synchronously
  before any I/O.
- After a successful write, the file contents exactly equal the input
  text (no normalization, no trailing newline added).

## Out of scope

- Diff display of the compaction in the TUI. Phase 5 owns that.
- Multi-author merge of memory files. Phase 2 assumes single writer.
- Choosing what the compactor prompt looks like — the default in
  `compactor.ts` is the only one shipped; tuning is a phase-6 problem.
