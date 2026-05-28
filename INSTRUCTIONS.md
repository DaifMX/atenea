# ATENEA — Implementation Plan

Python - uv
TypeScript - pnpm

## 1. Guiding principles
- **Coding-focused, single-user (initially), local-first.** No messaging adapters, no vision/TTS/media tools, no multi-platform gateway.
- **Open and provider-agnostic** like Hermes. Thin HTTP provider layer; no vendor SDK in the hot path.
- **Read by default, mutate only on explicit per-edit approval.** Never `git push`, never `git commit` without an explicit user command.
- **Self-improving on two axes**: (a) the code/doc/graph index refines itself as the repos and ATENEA's understanding evolve; (b) a strictly word-count-constrained `SKILLS.md` / `LESSONS.md` layer accumulates session takeaways.
- **All persistent markdown files have hard word-count caps**, enforced by a writer wrapper that refuses oversized writes and forces summarization.

## 2. Top-level architecturew

```
┌───────────────────────────── CLI / TUI (Ink, TS) ─────────────────────────────┐
│                                                                               │
│  ┌───────────────────── Agent Core (TypeScript pnpm) ──────────────────────┐  │
│  │  conversation_loop  │  prompt_builder  │  tool_executor  │  providers/  │  │
│  │           │                  │                 │                │       │  │
│  │           ▼                  ▼                 ▼                ▼       │  │
│  │     iter budget       5-tier prompt      parallel/serial   anthropic/   │  │
│  │     (cap 60)          (SOUL→MEM→USER     classification    openai/      │  │
│  │                        →SKILLS→AGENTS                      bedrock/     │  │
│  │                        →INDEX recall)                      ollama/      │  │
│  │                                                            openrouter   │  │
│  └────────────────┬──────────────────────────────────┬─────────────────────┘  │
│                   │ tool calls                       │ index queries (JSON-RPC│
│                   ▼                                  ▼ over Unix socket)      │
│  ┌─── Toolset (TS) ───┐               ┌────── Indexer Service (Python) ──────┐│
│  │ fs.read/write/edit │               │ tree-sitter parsers (20+ langs)      ││
│  │ git.log/diff/show  │               │ symbol extractor → SQLite            ││
│  │ rg / glob          │               │ file_summarizer (LLM)                ││
│  │ terminal (sandbox) │               │ dep_graph builder (networkx)         ││
│  │ index.* (RPC out)  │               │ embedder (BGE-M3 or OpenAI-compat)   ││
│  │ memory.* (md write)│               │ vector store (LanceDB, on-disk)      ││
│  │ approval.*         │               │ JSON-RPC server (Unix socket)        ││
│  └────────────────────┘               └──────────────────────────────────────┘│
└───────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                        ~/.atenea/    (workspace, state, index, memory)
```

## 3. Repository layout

```
atenea/
├── packages/
│   ├── core/                # TS — agent loop, prompt builder, tool executor
│   ├── providers/           # TS — anthropic/openai/bedrock/ollama/openrouter HTTP
│   ├── tools/               # TS — registered tool implementations
│   ├── cli/                 # TS — Ink-based TUI
│   └── indexer-client/      # TS — JSON-RPC client to Python service
├── services/
│   └── indexer/             # Python — parsing, embedding, dep graph, RPC server
│       ├── parsers/         # tree-sitter wrappers per language
│       ├── graph/           # cross-repo dependency builder
│       ├── embeddings/      # pluggable embedder (local + remote)
│       ├── store/           # LanceDB + SQLite + FTS5 wrappers
│       └── rpc/             # unix-socket JSON-RPC server
├── memory/                  # SOUL.md, MEMORY.md, USER.md, SKILLS.md, LESSONS.md
├── workspace/               # repo clones (gitignored)
├── state.db                 # SQLite WAL: sessions, approvals, audit log
└── atenea.toml              # repo list, provider config, caps
```

## 4. TypeScript (pnpm ONLY) agent core (`packages/core`)
- **`conversation_loop.ts`** — mirrors Hermes's `AIAgent`. LLM call → tool dispatch → re-prompt. Hard iteration cap of **60** per turn (lower than Hermes's 90 — coding sessions rarely need more).
- **`prompt_builder.ts`** — assembles the 5-tier stack in this fixed order, with the front portion marked for **provider prefix caching**:
  1. Base instructions (immutable)
  2. `SOUL.md` (persona, behavioral rules)
  3. `MEMORY.md` + `USER.md` (persistent facts about repos + you)
  4. `AGENTS.md` (per-repo: discovered conventions, build/test commands)
  5. `SKILLS.md` + `LESSONS.md` (procedural / learned)
  6. Live-injected: `index.search` recall snippets, current git status, open files
- **`tool_executor.ts`** — classifies tools into `read_parallel` (fs.read, rg, index.search, git.show) vs `mutate_serial` (fs.write, fs.edit, terminal). Up to 8 concurrent reads; mutations always serialized and individually gated by approval.
- **`providers/`** — one file per backend. Each exports a single `streamMessages(messages, tools)` async iterator returning a normalized event stream. No SDK dependency; raw `fetch` + SSE parsing. Credential pool with cooldowns (5 min on 401, 1 h on 429) ported from Hermes's design.

## 5. Python (uv ONLY) indexer service (`services/indexer`)
Runs as a long-lived process, JSON-RPC over a Unix socket at `~/.atenea/indexer.sock`. The TS agent calls it via tools (`index.search`, `graph.neighbors`, `summary.get`, `index.reindex`).

**Pipeline (per repo, on first add and on `git pull` deltas):**
1. **Parse** — tree-sitter pulls symbols (functions, classes, imports, exports, types) into SQLite tables.
2. **Summarize** — for each file > N tokens, LLM produces a ≤120-word summary stored in `file_summaries`. Re-summarized only on hash change.
3. **Dep graph** — networkx graph of (a) intra-repo import edges, (b) cross-repo edges via package name / API endpoint / message-queue topic detectors (configurable per stack). Persisted as a pickled graph + dumped JSON for inspection.
4. **Embed** — chunks (symbol-aware) embedded via configurable embedder. Default: **BGE-M3 local** for cost; switchable to OpenAI-compatible endpoint. Stored in **LanceDB** (good fit for 1M+ LOC, on-disk, no server).
5. **Doc/ADR ingestion** — markdown files under `docs/`, `adr/`, `architecture/`, plus all READMEs, embedded and tagged separately so `index.search` can filter.

**RPC surface (minimal):**
- `index.search(query, k, filters)` → top-k chunks with file path, repo, symbol, span
- `graph.neighbors(node, direction, depth)` → adjacency for architectural questions
- `graph.path(a, b)` → shortest path (e.g. "how does repo X reach service Y?")
- `summary.get(path)` / `summary.refresh(path)`
- `index.add_repo(path)` / `index.reindex(repo, since=sha)`

## 6. Memory tiers (word-count-constrained)
All files live under `memory/` and have a hard cap enforced by `memory.write`:

| File | Purpose | Cap |
|---|---|---|
| `SOUL.md` | Identity, behavioral rules, refusal policy | **400 words** |
| `USER.md` | Facts about you (role, preferences) | **300 words** |
| `MEMORY.md` | Stable team/repo facts | **600 words** |
| `AGENTS.md` (per repo) | Build/test/lint commands, conventions | **400 words / repo** |
| `SKILLS.md` | Procedural: "how to review a PR in repo X" | **800 words total**, individual skills ≤150 words |
| `LESSONS.md` | Mistakes-to-avoid, validated patterns | **600 words total**, individual entries ≤80 words |

The writer wrapper:
1. Refuses writes that exceed the cap.
2. On overflow, invokes a **compactor** LLM call that rewrites the file to ≤90% of the cap, preserving most-recently-relevant entries.
3. Every compaction is logged to `state.db` for audit and rollback.

## 7. Self-improvement mechanism
Two distinct loops, both opt-in per turn but on by default:

**A. Index refinement (background)** — after a session:
- Any file whose summary was *quoted* in the answer but later contradicted by user correction is queued for `summary.refresh`.
- Graph edges that the user explicitly confirmed/denied during the session are written to a `graph_overrides` table that the rebuild step respects.

**B. Markdown self-write (post-turn hook)** — mirrors Hermes's hindsight:
- A small LLM call inspects the turn and proposes 0–1 entries for `SKILLS.md` or `LESSONS.md`.
- Proposed entries are **shown to the user for one-keypress accept/reject** in the TUI before being appended. (Respects "no modification without authorization".)
- Accepted entries trigger the cap-enforcing writer.

## 8. Authorization layer (per-edit confirmation)
- `fs.write`, `fs.edit`, `terminal` route through an `approval` middleware.
- Each mutation shows a unified diff (or command preview) in the TUI; choices: **`y` apply / `n` skip / `a` always-this-file-this-session / `q` abort turn**.
- `git push`, `git commit`, `git reset --hard`, `rm -rf` are **hard-blocked** at the tool layer regardless of approval. To commit, the user runs `/commit` themselves in the TUI — which generates a message but invokes `git` only on a second confirmation.
- All approvals (and denials) recorded to `state.db` for audit.

## 9. CLI / TUI (`packages/cli`)
- Built with **Ink** (React for terminals) — clean way to render the streaming response + side panels.
- Layout: main chat pane, a collapsible right panel for "current context" (which files/symbols are in-prompt), bottom approval bar.
- Slash commands: `/repo add <path>`, `/repo list`, `/reindex`, `/graph <symbol>`, `/explain <path>`, `/memory show`, `/skills`, `/commit`, `/diff`, `/undo`.

## 10. Storage choices (at the 20+ repo / 1M+ LOC scale)
- **Vector store:** LanceDB (embedded, on-disk, fast, no server) — chosen over Chroma for stability at scale and over Qdrant to avoid the server dep.
- **Structured store:** SQLite WAL + FTS5 — same pattern as Hermes. Holds symbols, summaries, sessions, approvals, audit.
- **Graph:** networkx in-process, persisted as pickle + JSON snapshot. If it ever outgrows memory we move to kuzu; not at this scale.
- **State separation:** `~/.atenea/index/` (rebuildable) vs `~/.atenea/state.db` + `memory/` (precious, backed up).

## 11. Toolset (curated, coding-focused)
| Tool | Notes |
|---|---|
| `fs.read`, `fs.write`, `fs.edit`, `fs.glob` | Edit/write gated by approval |
| `rg`, `tree` | Read-only, parallel-safe |
| `git.status`, `git.log`, `git.diff`, `git.show`, `git.blame` | Read-only |
| `git.branch.create`, `git.checkout` | Gated, but allowed (branches are cheap) |
| `git.commit`, `git.push` | **Blocked**; only via `/commit` user command |
| `terminal` | Sandboxed cwd, command injection guards, allowlist (build/test/lint), prompts otherwise |
| `index.search`, `graph.neighbors`, `graph.path`, `summary.get` | RPC to Python service |
| `memory.read`, `memory.write` | Goes through cap-enforcing writer |
| `approval.request` | Used internally by mutation tools |

Explicitly **not included**: messaging, web browsing, image gen, TTS, scheduling, delegation. Web search is the one borderline case — useful for "what changed in lib X v3?" — I'd add a single `web.fetch` gated behind config-off-by-default.

## 12. Build phases

| Phase | Deliverable | Why this order |
|---|---|---|
| **0 — bootstrap** | Repo layout, `atenea.toml`, provider abstraction with Anthropic + OpenAI, "hello world" agent loop with `fs.read` and `rg` only | Smallest end-to-end loop you can actually talk to |
| **1 — containerization** | `Dockerfile` for the agent (TS CLI + future Python indexer), `compose.yaml` that brings up every service ATENEA needs (agent, indexer, any datastores), volume mounts for `~/.atenea/` state and `memory/` | Pins the runtime surface early so every later phase ships against a reproducible image instead of host-specific setups |
| **2 — memory + approval** | 5 markdown files with cap enforcement; per-edit approval middleware; SQLite state | Establishes the safety floor before adding any mutation power |
| **3 — indexer MVP** | Python service, tree-sitter for TS/Py/Go, file summaries, LanceDB embeddings, `index.search` over Unix socket | Unlocks "tell me what's in these repos" |
| **4 — dep graph** | Cross-repo edges, `graph.neighbors`, `graph.path` | The architectural-question feature |
| **5 — TUI polish** | Ink-based UI, slash commands, streaming, diff approval | What you actually use daily |
| **6 — self-improvement** | Post-turn hindsight, `SKILLS.md` / `LESSONS.md` writeback with accept/reject, summary refresh queue | The headline feature; built last because it needs the other layers to be stable |
| **7 — hardening** | Credential pool, prefix caching tuning, audit log review, incremental reindex on `git pull` | Production-readiness |

## 13. Open questions / risks
- **Embedder choice at 1M+ LOC.** Local BGE-M3 is free but slow on first ingest (hours). Remote (OpenAI / Voyage / Cohere) costs ~$30–80 for the initial pass. Worth picking explicitly.
- **Cross-language dep detection.** Easy intra-language (imports). Cross-repo edges via shared package names work, but service-to-service edges (HTTP, queues, gRPC) need per-stack heuristics — start with whichever 1–2 stacks the team uses.
- **Word-count cap UX.** When the compactor drops an entry the user wrote, the user should know. Plan: surface compactions in the TUI sidebar.
- **Skills accumulation drift.** Hermes self-generates skills aggressively; that can degrade quality. ATENEA's accept/reject + word cap is the guard, but worth reviewing `LESSONS.md` manually every few weeks.
