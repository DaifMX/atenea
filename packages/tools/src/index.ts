import type { ToolRegistry } from "@atenea/core";
import { fsReadTool } from "./fs_read.js";
import { rgTool } from "./rg.js";
import { fsWriteTool } from "./fs_write.js";
import { fsEditTool } from "./fs_edit.js";
import { memoryReadTool, memoryWriteTool } from "./memory_tools.js";

export { fsReadTool } from "./fs_read.js";
export { rgTool } from "./rg.js";
export { fsWriteTool } from "./fs_write.js";
export { fsEditTool } from "./fs_edit.js";
export { memoryReadTool, memoryWriteTool } from "./memory_tools.js";
export { unifiedDiff } from "./diff.js";

export function registerPhase0Tools(registry: ToolRegistry): void {
  registry.register(fsReadTool);
  registry.register(rgTool);
}

export function registerPhase2Tools(registry: ToolRegistry): void {
  registry.register(fsWriteTool);
  registry.register(fsEditTool);
  registry.register(memoryReadTool);
  registry.register(memoryWriteTool);
}
