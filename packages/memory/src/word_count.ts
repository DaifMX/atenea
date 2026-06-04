// Strip fenced code blocks (```...```), then count maximal runs of
// non-whitespace characters. Headings, list markers, and inline code count.
const FENCE_RE = /```[\s\S]*?```/g;

export function countWords(text: string): number {
  const stripped = text.replace(FENCE_RE, " ");
  const tokens = stripped.split(/\s+/).filter((t) => t.length > 0);
  return tokens.length;
}
