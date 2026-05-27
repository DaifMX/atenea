import type { ToolRegistry } from "@atenea/core";
import { fsReadTool } from "./fs_read.js";
import { rgTool } from "./rg.js";

export { fsReadTool } from "./fs_read.js";
export { rgTool } from "./rg.js";

// Phase 0 toolset: read-only filesystem + ripgrep. Everything else lands later.
export function registerPhase0Tools(registry: ToolRegistry): void {
  registry.register(fsReadTool);
  registry.register(rgTool);
}
