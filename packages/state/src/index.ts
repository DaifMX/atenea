import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "./migrations.js";
import type {
  ApprovalInput,
  ApprovalRow,
  CompactionInput,
  CompactionRow,
  SessionRow,
  ToolCallAuditInput,
  ToolCallRow,
} from "./types.js";

export * from "./types.js";

export interface OpenStateDbOpts {
  ateneaHome: string;
  migrate?: boolean;
}

export interface StateDb {
  readonly path: string;
  startSession(meta: { providerId: string; cwd: string }): SessionRow;
  endSession(id: number, summary?: string): void;
  recordApproval(input: ApprovalInput): ApprovalRow;
  recordToolCall(input: ToolCallAuditInput): ToolCallRow;
  recordCompaction(input: CompactionInput): CompactionRow;
  listApprovals(sessionId: number, limit?: number): ApprovalRow[];
  close(): void;
}

function nowIso(): string {
  return new Date().toISOString();
}

interface ApprovalDbRow {
  id: number;
  session_id: number;
  recorded_at: string;
  tool_name: string;
  target_path: string | null;
  decision: ApprovalInput["decision"];
  preview_hash: string;
  preview: string;
}

export function openStateDb(opts: OpenStateDbOpts): StateDb {
  const home = resolve(opts.ateneaHome);
  mkdirSync(home, { recursive: true });
  const path = resolve(home, "state.db");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  if (opts.migrate !== false) migrate(db);

  const insertSession = db.prepare(
    `INSERT INTO sessions (started_at, provider_id, cwd) VALUES (?, ?, ?)`,
  );
  const updateSessionEnd = db.prepare(
    `UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?`,
  );
  const insertApproval = db.prepare(
    `INSERT INTO approvals (session_id, recorded_at, tool_name, target_path, decision, preview_hash, preview)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAudit = db.prepare(
    `INSERT INTO tool_audit (session_id, called_at, tool_name, input_json, outcome, message)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertCompaction = db.prepare(
    `INSERT INTO memory_compactions (session_id, recorded_at, file, cap_words, before_words, after_words, before_text, after_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectApprovalsBySession = db.prepare(
    `SELECT * FROM approvals WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
  );

  function rowFromApproval(r: ApprovalDbRow): ApprovalRow {
    return {
      id: r.id,
      sessionId: r.session_id,
      recordedAt: r.recorded_at,
      toolName: r.tool_name,
      targetPath: r.target_path,
      decision: r.decision,
      previewHash: r.preview_hash,
      preview: r.preview,
    };
  }

  return {
    path,
    startSession(meta) {
      const startedAt = nowIso();
      const info = insertSession.run(startedAt, meta.providerId, meta.cwd);
      return {
        id: Number(info.lastInsertRowid),
        startedAt,
        endedAt: null,
        providerId: meta.providerId,
        cwd: meta.cwd,
        summary: null,
      };
    },
    endSession(id, summary) {
      updateSessionEnd.run(nowIso(), summary ?? null, id);
    },
    recordApproval(input) {
      const recordedAt = nowIso();
      const info = insertApproval.run(
        input.sessionId,
        recordedAt,
        input.toolName,
        input.targetPath,
        input.decision,
        input.previewHash,
        input.preview,
      );
      return {
        id: Number(info.lastInsertRowid),
        recordedAt,
        ...input,
      };
    },
    recordToolCall(input) {
      const calledAt = nowIso();
      const info = insertAudit.run(
        input.sessionId,
        calledAt,
        input.toolName,
        input.inputJson,
        input.outcome,
        input.message ?? null,
      );
      const row: ToolCallRow = {
        id: Number(info.lastInsertRowid),
        calledAt,
        sessionId: input.sessionId,
        toolName: input.toolName,
        inputJson: input.inputJson,
        outcome: input.outcome,
      };
      if (input.message !== undefined) row.message = input.message;
      return row;
    },
    recordCompaction(input) {
      const recordedAt = nowIso();
      const info = insertCompaction.run(
        input.sessionId,
        recordedAt,
        input.file,
        input.capWords,
        input.beforeWords,
        input.afterWords,
        input.beforeText,
        input.afterText,
      );
      return {
        id: Number(info.lastInsertRowid),
        recordedAt,
        ...input,
      };
    },
    listApprovals(sessionId, limit = 20) {
      const rows = selectApprovalsBySession.all(sessionId, limit) as ApprovalDbRow[];
      return rows.map(rowFromApproval);
    },
    close() {
      db.close();
    },
  };
}
