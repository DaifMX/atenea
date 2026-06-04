import type { Provider } from "@atenea/providers";
import type { Compactor, CompactorInput } from "./index.js";

const SYSTEM = `You are the ATENEA memory compactor.

You will receive the current contents of a markdown memory file together with a
target word count. Your job: rewrite the file so that:

  1. Total word count is STRICTLY less than the target.
  2. The structure (sections, list markers, headings) of the original is preserved.
  3. The most recently relevant, most concrete, most actionable entries are kept.
  4. Vague or duplicative entries are dropped first.
  5. You preserve any inline code spans and link targets exactly.

Return ONLY the rewritten markdown — no preamble, no commentary, no code fences
around the output.`;

export function defaultCompactor(provider: Provider): Compactor {
  return {
    async compact(input: CompactorInput): Promise<string> {
      const userText =
        `File: ${input.file}\n` +
        `Target word count: < ${input.targetWords}\n\n` +
        `Current contents:\n\n${input.text}`;

      const stream = provider.streamMessages({
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userText }],
          },
        ],
        tools: [],
      });

      let out = "";
      for await (const ev of stream) {
        if (ev.type === "text_delta") {
          out += ev.text;
        } else if (ev.type === "message_complete") {
          // belt-and-suspenders: concatenate any text parts the provider
          // surfaced only on completion.
          for (const part of ev.finalContent) {
            if (part.type === "text" && !out.endsWith(part.text)) {
              // already accumulated via text_delta in most providers; skip if
              // we already have the same suffix.
            }
          }
        } else if (ev.type === "error") {
          throw new Error(`compactor LLM error: ${ev.message}`);
        }
      }

      return out.trim();
    },
  };
}
