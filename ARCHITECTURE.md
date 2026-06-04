# ATENEA — Architecture

ATENEA is a coding agent (an *agent harness*) for working on a team's
repositories. It is **local-first**, **provider-agnostic**, and **read-by-default**:
it can freely read and search code, but every mutation is gated behind explicit,
per-edit human approval, and a small set of dangerous operations are hard-blocked
at the tool layer regardless of approval.

This document describes the architecture **as implemented today** (phases 0–2:
the agent loop, providers, memory, approval, state, and a terminal REPL). The
longer-term design — a Python indexer service, dependency graph, vector search,
and self-improvement loops — is described in [INSTRUCTIONS.md](INSTRUCTIONS.md)
and is not yet built. Where this file mentions those, it labels them as planned.

---

## 1. Big picture

ATENEA is a TypeScript **pnpm monorepo**. A single Node process runs a terminal
REPL that drives an agent loop: it sends the conversation to an LLM provider,
the model asks to call tools, ATENEA executes those tools (reads in parallel,
mutations one-at-a-time behind approval), feeds the results back, and repeats
until the model stops or an iteration cap is hit.

```
┌──────────────────────────── CLI / REPL (@atenea/cli) ────────────────────────────┐
│  readline loop · slash commands · approval prompter · session lifecycle          │
│                                                                                  │
│   user turn                                                                      │
│      │                                                                           │
│      ▼                                                                           │
│  ┌──────────────────────── Agent Core (@atenea/core) ─────────────────────────┐  │
│  │  prompt_builder ──▶ conversation_loop ──▶ tool_executor                     │  │
│  │   (5-tier system     (LLM call ↔ tool      (read_parallel ⇉ 8 concurrent,   │  │
│  │    prompt)            dispatch, cap 60)     mutate_serial 1-at-a-time)       │  │
│  │                              │                      │                        │  │
│  │                              ▼                      ▼                        │  │
│  │                       providers/*           approval gate + hard-blocks      │  │
│  └──────────┬───────────────────┬─────────────────────┬────────────────────────┘  │
│             │ streamMessages    │ tool defs           │ approve / audit           │
│             ▼                   ▼                     ▼                            │
│   @atenea/providers      @atenea/tools         @atenea/state (SQLite WAL)          │
│   anthropic·openai·      fs.read/write/edit·   sessions·approvals·tool_audit·      │
│   openrouter (raw        rg·memory.read/write  memory_compactions                  │
│   fetch + SSE)                  │                                                  │
│                                 ▼                                                  │
│                          @atenea/memory                                            │
│                          5 capped markdown docs + compactor                        │
└───────────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                          atenea.toml  ·  ./memory/*.md  ·  ~/.atenea/state.db
```

---

## 2. Package layout

The monorepo is defined by [pnpm-workspace.yaml](pnpm-workspace.yaml) (`packages/*`)
and a shared [tsconfig.base.json](tsconfig.base.json). Each package is an
independent ESM TypeScript module under the `@atenea/*` scope.

| Package | Path | Responsibility |
| --- | --- | --- |
| `@atenea/config` | [packages/config](packages/config) | Load & validate `atenea.toml`; expand `${ENV}`; select a provider. |
| `@atenea/providers` | [packages/providers](packages/providers) | Normalized LLM message/event types; one HTTP client per backend. |
| `@atenea/core` | [packages/core](packages/core) | Prompt builder, conversation loop, tool registry/executor, approval gate. |
| `@atenea/tools` | [packages/tools](packages/tools) | Concrete tool implementations (`fs.read`, `rg`, `fs.write`, `fs.edit`, `memory.*`). |
| `@atenea/memory` | [packages/memory](packages/memory) | Word-count-capped markdown memory store + compactor. |
| `@atenea/state` | [packages/state](packages/state) | SQLite (WAL) store: sessions, approvals, tool audit, compaction journal. |
| `@atenea/cli` | [packages/cli](packages/cli) | Terminal REPL, slash commands, wiring everything together. |

### Dependency direction

```
cli ──▶ core ──▶ providers
  │       │  └──▶ state
  │       └────▶ (tool.ts depends on state + a structural MemoryStoreLike)
  ├────▶ tools ──▶ core, memory, state
  ├────▶ memory ─▶ state
  ├────▶ config
  └────▶ providers
```

`@atenea/core` deliberately does **not** depend on `@atenea/memory`. Instead
[tool.ts](packages/core/src/tool.ts) declares a minimal structural interface
(`MemoryStoreLike`) that the real `MemoryStore` happens to satisfy. This keeps
the core loop decoupled from the memory implementation.

---

## 3. The agent core (`@atenea/core`)

### 3.1 Conversation loop

[conversation_loop.ts](packages/core/src/conversation_loop.ts) is the heart of
the harness. `runTurn()` takes the prior history plus a new user input and runs
an iterative loop, bounded by `maxIterations` (default **60**, from
`agent.max_iterations` in config):

1. Call `provider.streamMessages({ system, messages, tools })` and consume the
   event stream, surfacing deltas through optional `onEvent` callbacks for live
   rendering.
2. On `message_complete`, append the assistant message to `messages`.
3. If the model produced no `tool_use` parts (or stopped for a non-tool reason),
   return — the turn is done.
4. Otherwise dispatch the tool calls via `executeToolCalls`, append the
   `tool_result` parts as a synthetic user message, and loop.

If the loop exhausts its budget it returns `stopReason: "max_iterations"`. A
user abort raised at an approval prompt (`AbortApprovalError`) is caught and
turned into a clean `stopReason: "error"` rather than crashing the process.

### 3.2 Tool registry & executor

[tool.ts](packages/core/src/tool.ts) defines `ToolDefinition` (name,
description, JSON input schema, a `classification`, and an `execute` function)
and a `ToolRegistry` that holds them and can emit provider-facing `ToolSchema[]`.

Every tool is classified as one of:

- **`read_parallel`** — pure reads, safe to fan out (`fs.read`, `rg`).
- **`mutate_serial`** — anything touching the working tree or external state
  (`fs.write`, `fs.edit`, `memory.write`).

[tool_executor.ts](packages/core/src/tool_executor.ts) uses that classification
to run all read-parallel calls first with a bounded worker pool
(`MAX_PARALLEL = 8`), then runs the serial mutations one at a time. Result order
always matches input order so the model sees a stable mapping. Individual tool
errors are caught and returned as `isError` results (so one bad call doesn't kill
the turn), but an `AbortApprovalError` propagates up to abort the whole turn.
Oversized outputs are truncated to `MAX_RESULT_CHARS` (20k) to protect the
context window.

### 3.3 Prompt builder

[prompt_builder.ts](packages/core/src/prompt_builder.ts) assembles the system
prompt from a fixed-order stack of optional sections: base instructions →
`SOUL` → `MEMORY` → `USER` → `AGENTS` → `SKILLS` → `LESSONS` → live `CONTEXT`.
Empty sections are skipped. Today the markdown docs are loaded from disk at
startup; the live-context recall (index search, git status) is reserved for a
later phase.

---

## 4. Providers (`@atenea/providers`)

The provider layer isolates the rest of the system from any vendor SDK. The
agent core only ever sees the **normalized types** in
[types.ts](packages/providers/src/types.ts): `ContentPart`
(`text` / `tool_use` / `tool_result`), `Message`, `ToolSchema`, and a unified
`StreamEvent` union (`text_delta`, `tool_use_*`, `message_complete`, `error`).

Each backend implements the `Provider` interface with a single
`streamMessages(req, signal)` method returning an `AsyncIterable<StreamEvent>`:

- [anthropic.ts](packages/providers/src/anthropic.ts) — Anthropic Messages API.
- [openai.ts](packages/providers/src/openai.ts) — OpenAI Chat Completions.
- [openrouter.ts](packages/providers/src/openrouter.ts) — OpenRouter
  (OpenAI-compatible, with optional ranking headers).

These are thin: raw `fetch` plus SSE parsing ([sse.ts](packages/providers/src/sse.ts)),
no vendor SDKs in the hot path. `createProvider(cfg)` in
[index.ts](packages/providers/src/index.ts) is the factory that maps a
`ProviderConfig.kind` to the right class. Adding a backend means adding one file
and one switch arm — nothing else in the system changes.

---

## 5. Tools (`@atenea/tools`)

Tools are registered in two tiers from [index.ts](packages/tools/src/index.ts):

- `registerPhase0Tools` → `fs.read`, `rg` (read-only).
- `registerPhase2Tools` → `fs.write`, `fs.edit`, `memory.read`, `memory.write`
  (mutations + memory).

Key safety properties live here:

- **Path confinement** — [path_safety.ts](packages/tools/src/path_safety.ts)'s
  `resolveSafe(cwd, path)` rejects any path that escapes the working directory.
- **Per-edit approval** — mutation tools like
  [fs_edit.ts](packages/tools/src/fs_edit.ts) first check the hard-block list,
  then build a unified diff ([diff.ts](packages/tools/src/diff.ts)) and call
  `ctx.approval.request(...)` *before* writing. Writes are atomic
  (write-to-temp + rename).
- **Auditing** — every mutating tool records its outcome
  (`ok` / `blocked` / `denied` / `error`) via
  [audit.ts](packages/tools/src/audit.ts) into the state DB.

---

## 6. Approval gate & hard blocks

The authorization layer lives in [approval.ts](packages/core/src/approval.ts)
and is the safety floor of the whole system. It has two responsibilities:

1. **Hard blocks (non-negotiable).** `DEFAULT_HARD_BLOCKS` rejects, *regardless
   of user approval*: `git_commit` / `git_push` tools, `terminal` commands that
   match `git push|commit|reset --hard` or `rm -rf`, and any `fs.write` / `fs.edit`
   targeting a `.git` path. A mutation tool calls `isHardBlocked(name, input)`
   before doing anything; a block short-circuits to an audited `blocked` result.

2. **Interactive approval.** For allowed mutations, `request(req)` shows the
   preview (a diff or command) through an `ApprovalPrompter` and returns an
   `ApprovalDecision`: `allow`, `allow_always_file`, `deny`, or `abort`.
   - `allow_always_file` caches an allow for that `(tool, path)` pair for the
     rest of the session.
   - `abort` throws `AbortApprovalError`, which unwinds the executor and ends the
     turn cleanly.
   - Every decision is hashed (`sha256` of the preview) and persisted to
     `state.db` for audit.

The CLI supplies the actual prompter
([approval_prompt.ts](packages/cli/src/approval_prompt.ts)) backed by readline,
so the gate logic stays UI-agnostic and testable.

---

## 7. Memory (`@atenea/memory`)

ATENEA's persistent knowledge is a set of plain markdown files under `./memory/`,
each with a **hard word-count cap** enforced by the writer
([index.ts](packages/memory/src/index.ts)):

| File | Default cap |
| --- | --- |
| `SOUL.md` | 400 |
| `USER.md` | 300 |
| `MEMORY.md` | 600 |
| `AGENTS.md` | 400 |
| `SKILLS.md` | 800 |
| `LESSONS.md` | 600 |

`write(file, text)` (see [word_count.ts](packages/memory/src/word_count.ts) and
[paths.ts](packages/memory/src/paths.ts)) behaves as:

- Under cap → write atomically, return `written`.
- Over cap, no compactor → refuse (`refused`), the file is left untouched.
- Over cap, compactor present → invoke an LLM **compactor**
  ([compactor.ts](packages/memory/src/compactor.ts)) to rewrite the content down
  to ~90% of the cap, write the result (`compacted`), and journal the before/after
  into `memory_compactions` for audit and rollback.

This guarantees the system prompt's memory tier can never grow unbounded.

---

## 8. State (`@atenea/state`)

[index.ts](packages/state/src/index.ts) opens an embedded **SQLite database in
WAL mode** at `~/.atenea/state.db` (`synchronous=NORMAL`, `foreign_keys=ON`).
The schema ([migrations.ts](packages/state/src/migrations.ts), versioned via
`user_version`) holds four tables:

- **`sessions`** — one row per REPL run (provider, cwd, start/end, summary).
- **`approvals`** — every approval decision with a preview hash.
- **`tool_audit`** — every mutating tool call and its outcome.
- **`memory_compactions`** — full before/after text of each memory rewrite.

This is the durable, *precious* store (audit + safety record), kept separate
from rebuildable artifacts. It is the single source of truth for "what did the
agent do, and what did the human authorize?"

---

## 9. Config (`@atenea/config`)

[index.ts](packages/config/src/index.ts) parses `atenea.toml`
(see [atenea.toml.example](atenea.toml.example)) with `smol-toml`, recursively
expands `${ENV_VAR}` references (failing fast if one is unset), and validates:

- `agent.max_iterations` (default 60) and `agent.default_provider`.
- At least one `[[providers]]` entry, each with `id`, `kind`
  (`anthropic` | `openai` | `openrouter`), `model`, and `api_key`; the default
  provider id must match one of them.
- `memory.dir` and `workspace.dir`, resolved relative to the config file.

`getProvider(cfg, id?)` selects the active provider for a run.

---

## 10. CLI / REPL (`@atenea/cli`)

[index.ts](packages/cli/src/index.ts) is the composition root. On startup it:

1. Parses args, resolves the config path, loads config, and builds the provider.
2. Resolves `~/.atenea` (or `ATENEA_HOME`), opens the state DB, and starts a
   session row.
3. Creates the memory store (wired to a provider-backed compactor), the approval
   gate (wired to a readline prompter + state DB), and the tool registry
   (phase 0 + phase 2 tools).
4. Loads the memory docs, builds the system prompt, assembles a `ToolContext`
   (cwd, approval, memory, stateDb, sessionId), and hands control to the REPL.
5. Registers an `exit` hook that ends the session and closes the DB.

[repl.ts](packages/cli/src/repl.ts) runs the readline loop. Plain input becomes
a turn via `runTurn`; lines starting with `/` are slash commands:
`/help`, `/exit`, `/quit`, `/clear`, `/memory ...`
([slash_memory.ts](packages/cli/src/slash_memory.ts)), and `/approvals ...`
([slash_approvals.ts](packages/cli/src/slash_approvals.ts)). Conversation
history is held in memory for the lifetime of the REPL.

---

## 11. Runtime & data locations

- `atenea.toml` — repo-local configuration (providers, caps, dirs).
- `./memory/*.md` — the capped markdown knowledge base (precious).
- `~/.atenea/state.db` — SQLite WAL audit/state store (precious).
- [Dockerfile](Dockerfile) + [compose.yaml](compose.yaml) — containerized
  runtime so later phases ship against a reproducible image.

---

## 12. Design principles in one place

- **Read by default, mutate only on explicit per-edit approval.** Reads fan out;
  mutations are serialized and individually gated.
- **Hard blocks beat approval.** `git push/commit/reset --hard`, `rm -rf`, and
  `.git` writes can't be approved through — committing is a deliberate human
  action.
- **Provider-agnostic.** The core speaks one normalized message/event vocabulary;
  backends are thin, swappable HTTP clients with no SDK in the hot path.
- **Everything mutating is audited.** Sessions, approvals, tool calls, and memory
  compactions are all journaled to SQLite.
- **Bounded memory.** Persistent markdown has hard word caps enforced by a writer
  that compacts (and journals) on overflow.
- **Decoupled by structural typing.** The core loop depends on interfaces
  (`MemoryStoreLike`, `ApprovalPrompter`, `Provider`), not concrete packages, so
  pieces can be swapped or tested in isolation.

---

## 13. Not yet built (planned)

The following appear in the design ([INSTRUCTIONS.md](INSTRUCTIONS.md)) but are
not part of the current implementation: the Python **indexer service**
(tree-sitter parsing, file summaries, embeddings/pgVector, JSON-RPC over a Unix
socket), the cross-repo **dependency graph** (`graph.neighbors` / `graph.path`),
the **self-improvement** loops (post-turn hindsight writeback to
`SKILLS.md` / `LESSONS.md`, summary refresh), an **Ink-based TUI**, and the
broader git/terminal toolset. They are intentionally deferred to later phases.
