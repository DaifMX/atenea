import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parse as parseToml } from "smol-toml";

export type ProviderKind = "anthropic" | "openai" | "openrouter";

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  model: string;
  apiKey: string;
  baseUrl?: string;
  // OpenRouter-only: optional ranking headers sent on every request.
  httpReferer?: string;
  xTitle?: string;
}

export interface AgentConfig {
  maxIterations: number;
  defaultProvider: string;
}

export interface AteneaConfig {
  agent: AgentConfig;
  providers: ProviderConfig[];
  memoryDir: string;
  workspaceDir: string;
  configPath: string;
}

const ENV_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function expandEnv(value: string): string {
  return value.replace(ENV_RE, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new Error(`atenea.toml: env var \${${name}} is not set`);
    }
    return v;
  });
}

function expandStringsDeep(v: unknown): unknown {
  if (typeof v === "string") return expandEnv(v);
  if (Array.isArray(v)) return v.map(expandStringsDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = expandStringsDeep(val);
    }
    return out;
  }
  return v;
}

function asString(v: unknown, ctx: string): string {
  if (typeof v !== "string") throw new Error(`atenea.toml: ${ctx} must be a string`);
  return v;
}

function asNumber(v: unknown, ctx: string): number {
  if (typeof v !== "number") throw new Error(`atenea.toml: ${ctx} must be a number`);
  return v;
}

function parseProvider(raw: unknown, idx: number): ProviderConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error(`atenea.toml: providers[${idx}] must be a table`);
  }
  const r = raw as Record<string, unknown>;
  const kind = asString(r.kind, `providers[${idx}].kind`);
  if (kind !== "anthropic" && kind !== "openai" && kind !== "openrouter") {
    throw new Error(
      `atenea.toml: providers[${idx}].kind must be 'anthropic', 'openai', or 'openrouter'`,
    );
  }
  const cfg: ProviderConfig = {
    id: asString(r.id, `providers[${idx}].id`),
    kind,
    model: asString(r.model, `providers[${idx}].model`),
    apiKey: asString(r.api_key, `providers[${idx}].api_key`),
  };
  if (r.base_url !== undefined) cfg.baseUrl = asString(r.base_url, `providers[${idx}].base_url`);
  if (r.http_referer !== undefined) {
    cfg.httpReferer = asString(r.http_referer, `providers[${idx}].http_referer`);
  }
  if (r.x_title !== undefined) {
    cfg.xTitle = asString(r.x_title, `providers[${idx}].x_title`);
  }
  return cfg;
}

export async function loadConfig(path: string): Promise<AteneaConfig> {
  const abs = resolve(path);
  const text = await readFile(abs, "utf8");
  const raw = expandStringsDeep(parseToml(text)) as Record<string, unknown>;

  const agentRaw = (raw.agent ?? {}) as Record<string, unknown>;
  const agent: AgentConfig = {
    maxIterations: asNumber(agentRaw.max_iterations ?? 60, "agent.max_iterations"),
    defaultProvider: asString(agentRaw.default_provider, "agent.default_provider"),
  };

  const provRaw = raw.providers;
  if (!Array.isArray(provRaw) || provRaw.length === 0) {
    throw new Error("atenea.toml: at least one [[providers]] entry required");
  }
  const providers = provRaw.map(parseProvider);

  if (!providers.some((p) => p.id === agent.defaultProvider)) {
    throw new Error(
      `atenea.toml: agent.default_provider '${agent.defaultProvider}' does not match any provider id`,
    );
  }

  const memRaw = (raw.memory ?? {}) as Record<string, unknown>;
  const wsRaw = (raw.workspace ?? {}) as Record<string, unknown>;
  const configDir = dirname(abs);

  return {
    agent,
    providers,
    memoryDir: resolve(configDir, asString(memRaw.dir ?? "./memory", "memory.dir")),
    workspaceDir: resolve(configDir, asString(wsRaw.dir ?? "./workspace", "workspace.dir")),
    configPath: abs,
  };
}

export function getProvider(cfg: AteneaConfig, id?: string): ProviderConfig {
  const target = id ?? cfg.agent.defaultProvider;
  const p = cfg.providers.find((x) => x.id === target);
  if (!p) throw new Error(`provider '${target}' not found in atenea.toml`);
  return p;
}
