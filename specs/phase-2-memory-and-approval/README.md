# Phase 2 — Memory + Approval

This phase establishes the **safety floor** for ATENEA: a place to persist
team/user/skill facts under hard caps, and a per-edit approval gate so the
agent cannot mutate the working tree without explicit human consent.

Phase 2 adds **no mutation power** beyond what the user opts into through
the gate. Indexer / mutation tools that exceed `fs_write` / `fs_edit` are
deferred to later phases.

## Domains (one spec per domain)

1. [state-db](./state-db.md) — embedded SQLite (`state.db`) holding sessions,
   approvals, audit, and the memory compaction journal.
2. [memory-writer](./memory-writer.md) — cap-enforcing reader/writer over the
   six markdown tiers in `memory/`. Refuses oversized writes; on overflow
   delegates to an LLM compactor.
3. [approval-gate](./approval-gate.md) — middleware that mutation tools call
   into. Implements `y / n / a / q` semantics, the session-scoped
   "always-this-file" cache, and the hard-block list.
4. [mutation-tools](./mutation-tools.md) — the four new tools that compose
   the above: `fs_write`, `fs_edit`, `memory_read`, `memory_write`.
5. [cli-integration](./cli-integration.md) — how the CLI surfaces the
   approval prompt, opens `state.db`, and exposes the `/memory` and
   `/approvals` slash commands.

## Dependency order (build top-down)

```
state-db ──┬──► memory-writer ──┐
           │                    ├──► mutation-tools ──► cli-integration
           └──► approval-gate ──┘
```

`state-db` is the lowest layer; `cli-integration` is the highest. Specs
cross-link via relative `./<other>.md` paths.

## Phase-2 invariants (must hold across all domains)

- **No mutation without approval.** Every `mutate_serial` tool call that
  touches the working tree, the memory directory, or any external state
  goes through the approval gate. Approval decisions are persisted before
  the mutation runs.
- **No silent loss.** The memory writer never truncates user content
  without an LLM compaction pass; if compaction is unavailable, the write
  is refused.
- **Hard-blocks are unreachable.** `git push`, `git commit`,
  `git reset --hard`, and `rm -rf` are rejected at the tool layer before
  the approval gate even sees them.
- **Everything is audited.** Every approval decision (allow OR deny) and
  every memory compaction lands in `state.db` with timestamps and the
  inputs that produced it.
