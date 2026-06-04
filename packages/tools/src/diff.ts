// Minimal unified-diff renderer. Computes a line-level LCS and emits a single
// hunk covering the entire file. Good enough for the approval preview; not
// trying to be patch(1)-compatible.

function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i]!;
    const rowNext = dp[i + 1]!;
    for (let j = n - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? rowNext[j + 1]! + 1 : Math.max(rowNext[j]!, row[j + 1]!);
    }
  }
  return dp;
}

interface Op {
  kind: " " | "-" | "+";
  text: string;
}

function diffOps(a: string[], b: string[]): Op[] {
  const dp = lcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "-", text: a[i]! });
      i++;
    } else {
      ops.push({ kind: "+", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: "-", text: a[i++]! });
  while (j < b.length) ops.push({ kind: "+", text: b[j++]! });
  return ops;
}

export function unifiedDiff(oldText: string, newText: string, path: string): string {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const ops = diffOps(a, b);

  if (ops.every((o) => o.kind === " ")) {
    return `--- ${path}\n+++ ${path}\n(no changes)\n`;
  }

  const header = `--- ${path}\n+++ ${path}\n@@ -1,${a.length} +1,${b.length} @@\n`;
  const body = ops.map((o) => `${o.kind}${o.text}`).join("\n");
  return `${header}${body}\n`;
}
