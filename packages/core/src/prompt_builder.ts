// Phase 0 prompt builder. The 5-tier stack lives here but most layers are
// stubs until the memory and indexer subsystems land in phases 1–2.

const BASE_INSTRUCTIONS = `You are ATENEA, a coding agent that works on a team's repositories.

You can call tools to read files and search code. You cannot modify code in this
phase. Be precise; cite file paths and line numbers when you reference code.
When a task is done, stop calling tools and produce a final answer.`;

export interface PromptInputs {
  soulMd?: string;
  memoryMd?: string;
  userMd?: string;
  agentsMd?: string;
  skillsMd?: string;
  lessonsMd?: string;
  // Live context injected per turn (phase 2+).
  liveContext?: string;
}

export function buildSystemPrompt(input: PromptInputs): string {
  const sections: string[] = [BASE_INSTRUCTIONS];
  if (input.soulMd?.trim()) sections.push(`# SOUL\n${input.soulMd.trim()}`);
  if (input.memoryMd?.trim()) sections.push(`# MEMORY\n${input.memoryMd.trim()}`);
  if (input.userMd?.trim()) sections.push(`# USER\n${input.userMd.trim()}`);
  if (input.agentsMd?.trim()) sections.push(`# AGENTS\n${input.agentsMd.trim()}`);
  if (input.skillsMd?.trim()) sections.push(`# SKILLS\n${input.skillsMd.trim()}`);
  if (input.lessonsMd?.trim()) sections.push(`# LESSONS\n${input.lessonsMd.trim()}`);
  if (input.liveContext?.trim()) sections.push(`# CONTEXT\n${input.liveContext.trim()}`);
  return sections.join("\n\n");
}
