import type { Interface as ReadlineInterface } from "node:readline";
import { stdout as output } from "node:process";
import type { ApprovalPrompter, ApprovalRequest, ApprovalDecision } from "@atenea/core";

function renderHeader(req: ApprovalRequest): string {
  const path = req.targetPath ? ` ${req.targetPath}` : "";
  const summary = req.summary ? ` — ${req.summary}` : "";
  return `── approval requested: ${req.toolName}${path}${summary} ──`;
}

export function createReadlinePrompter(rl: ReadlineInterface): ApprovalPrompter {
  return {
    async prompt(req: ApprovalRequest): Promise<ApprovalDecision> {
      output.write(`\n${renderHeader(req)}\n${req.preview}`);
      if (!req.preview.endsWith("\n")) output.write("\n");
      output.write("── [y] apply  [n] skip  [a] always-this-file  [q] abort ──\n");

      while (true) {
        const ans = await new Promise<string>((res) => {
          rl.question("approve> ", res);
        });
        const t = ans.trim().toLowerCase();
        if (t === "y" || t === "yes") return { kind: "allow" };
        if (t === "n" || t === "no") return { kind: "deny", reason: "user declined" };
        if (t === "a" || t === "always") return { kind: "allow_always_file" };
        if (t === "q" || t === "abort") return { kind: "abort" };
        output.write("? expected one of y / n / a / q\n");
      }
    },
  };
}
