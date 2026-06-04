import type { ToolSchema } from "@atenea/providers";
import type { StateDb } from "@atenea/state";
import type { ApprovalGate } from "./approval.js";

// Tools are classified for the executor:
//   read_parallel  — pure reads, safe to fan out (fs.read, rg, index.search)
//   mutate_serial  — anything that touches the working tree or external state
export type ToolClass = "read_parallel" | "mutate_serial";

// Minimal structural type so the core package does not depend on @atenea/memory.
// @atenea/memory's MemoryStore matches this shape.
export interface MemoryStoreLike {
  readonly memoryDir: string;
  read(file: unknown): Promise<string | undefined>;
  write(file: unknown, text: string): Promise<unknown>;
  capFor(file: unknown): number;
  countWords(text: string): number;
}

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  approval?: ApprovalGate;
  memory?: MemoryStoreLike;
  stateDb?: StateDb;
  sessionId?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  classification: ToolClass;
  execute: (input: unknown, ctx: ToolContext) => Promise<string>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    if (this.#tools.has(def.name)) {
      throw new Error(`tool '${def.name}' already registered`);
    }
    this.#tools.set(def.name, def);
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  schemas(): ToolSchema[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }
}
