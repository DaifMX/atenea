// Minimal SSE line-frame parser. Yields { event?, data } records.
// Both Anthropic and OpenAI use SSE for streaming; we share the same parser
// and let the per-provider adapter interpret the events.

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  let event: string | undefined;
  let dataLines: string[] = [];

  const flush = (): SseEvent | undefined => {
    if (dataLines.length === 0 && event === undefined) return undefined;
    const ev: SseEvent = { data: dataLines.join("\n") };
    if (event !== undefined) ev.event = event;
    event = undefined;
    dataLines = [];
    return ev;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const rawLine = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      if (line === "") {
        const ev = flush();
        if (ev) yield ev;
        continue;
      }
      if (line.startsWith(":")) continue; // comment / keepalive

      const sep = line.indexOf(":");
      const field = sep === -1 ? line : line.slice(0, sep);
      let val = sep === -1 ? "" : line.slice(sep + 1);
      if (val.startsWith(" ")) val = val.slice(1);

      if (field === "event") event = val;
      else if (field === "data") dataLines.push(val);
      // id and retry fields ignored
    }
  }
  const last = flush();
  if (last) yield last;
}
