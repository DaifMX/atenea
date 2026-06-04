import { stdout as output } from "node:process";
import type { StateDb } from "@atenea/state";

export function handleApprovalsCommand(
  stateDb: StateDb,
  sessionId: number,
  argv: string[],
): void {
  const n = Number.parseInt(argv[0] ?? "20", 10);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 20;
  const rows = stateDb.listApprovals(sessionId, limit);
  if (rows.length === 0) {
    output.write("(no approvals recorded this session)\n");
    return;
  }
  for (const r of rows) {
    const path = r.targetPath ?? "-";
    output.write(`${r.recordedAt}  ${r.decision.padEnd(12)} ${r.toolName.padEnd(10)} ${path}\n`);
  }
}
