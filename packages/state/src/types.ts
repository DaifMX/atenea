export type ApprovalDecisionKind = "allow" | "deny" | "always_file";

export type ToolOutcome = "ok" | "blocked" | "denied" | "error";

export interface SessionRow {
  id: number;
  startedAt: string;
  endedAt: string | null;
  providerId: string;
  cwd: string;
  summary: string | null;
}

export interface ApprovalInput {
  sessionId: number;
  toolName: string;
  targetPath: string | null;
  decision: ApprovalDecisionKind;
  previewHash: string;
  preview: string;
}

export interface ApprovalRow extends ApprovalInput {
  id: number;
  recordedAt: string;
}

export interface ToolCallAuditInput {
  sessionId: number;
  toolName: string;
  inputJson: string;
  outcome: ToolOutcome;
  message?: string;
}

export interface ToolCallRow extends ToolCallAuditInput {
  id: number;
  calledAt: string;
}

export interface CompactionInput {
  sessionId: number;
  file: string;
  capWords: number;
  beforeWords: number;
  afterWords: number;
  beforeText: string;
  afterText: string;
}

export interface CompactionRow extends CompactionInput {
  id: number;
  recordedAt: string;
}
