import type { AgentProfileItemDetail, AgentProfileProvider } from "@t3tools/contracts";

/** One hook matcher group in a provider's own hook format, with where it sits in that file. */
export interface HookGroup {
  /** Claude and Codex: `[event]`. Antigravity: `[hookSetName, event]`. */
  readonly path: readonly string[];
  readonly index: number;
  readonly group: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function eventGroups(events: unknown, prefix: readonly string[]): HookGroup[] {
  if (!isRecord(events)) return [];
  return Object.entries(events).flatMap(([event, groups]) =>
    Array.isArray(groups)
      ? groups.map((group, index) => ({ path: [...prefix, event], index, group }))
      : [],
  );
}

/**
 * Reads a hook file in the provider's own format. Claude and Codex: `{ "hooks": { Event: [group] } }`
 * (a bare `{ Event: [group] }`, the value of Claude's `settings.json` `hooks`, also works).
 * Antigravity: `{ "<hook set>": { Event: [group] } }`.
 */
export function flattenHooks(provider: AgentProfileProvider, native: unknown): HookGroup[] {
  if (!isRecord(native)) return [];
  if (provider === "antigravity")
    return Object.entries(native).flatMap(([set, events]) => eventGroups(events, [set]));
  return eventGroups(isRecord(native.hooks) ? native.hooks : native, []);
}

/**
 * The provider's own hook content for these groups, in order. Claude: the value of `settings.json`
 * `hooks`. Codex: the whole `hooks.json`. Antigravity: the whole `config/hooks.json`.
 */
export function assembleHooks(
  provider: AgentProfileProvider,
  groups: readonly Pick<HookGroup, "path" | "group">[],
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const { path, group } of groups) {
    let parent = root;
    for (const key of path.slice(0, -1)) {
      if (!isRecord(parent[key])) parent[key] = {};
      parent = parent[key] as Record<string, unknown>;
    }
    const event = path.at(-1)!;
    parent[event] = [...((parent[event] as unknown[] | undefined) ?? []), group];
  }
  return provider === "codex" ? { hooks: root } : root;
}

export function hookDetail(group: HookGroup): AgentProfileItemDetail {
  const value = isRecord(group.group) ? group.group : {};
  const commands = (Array.isArray(value.hooks) ? value.hooks : [])
    .map((hook) => (isRecord(hook) && typeof hook.command === "string" ? hook.command : undefined))
    .filter((command): command is string => command !== undefined);
  return {
    event: group.path.at(-1)!,
    ...(typeof value.matcher === "string" ? { matcher: value.matcher } : {}),
    commands,
  };
}

/** One MCP server as written in `mcp.json` (`mcpServers` map, Claude/Gemini style) or Codex TOML. */
export interface McpServerSpec {
  readonly type?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

export function readMcpServers(value: unknown): Record<string, McpServerSpec> {
  const servers = isRecord(value) && isRecord(value.mcpServers) ? value.mcpServers : value;
  if (!isRecord(servers)) return {};
  return Object.fromEntries(
    Object.entries(servers).filter((entry): entry is [string, McpServerSpec] => isRecord(entry[1])),
  );
}

/** What the screen may show of an MCP server: no `env` or header values, only their names. */
export function mcpDetail(spec: McpServerSpec): AgentProfileItemDetail {
  const headers = isRecord(spec.headers)
    ? spec.headers
    : isRecord(spec.http_headers)
      ? spec.http_headers
      : undefined;
  const url = typeof spec.url === "string" ? spec.url : undefined;
  return {
    transport: url ? (spec.type === "sse" ? "sse" : "http") : "stdio",
    ...(typeof spec.command === "string" ? { command: spec.command } : {}),
    ...(Array.isArray(spec.args) ? { args: spec.args.map(String) } : {}),
    ...(url ? { url } : {}),
    ...(isRecord(spec.env) ? { envKeys: Object.keys(spec.env).sort() } : {}),
    ...(headers ? { headerKeys: Object.keys(headers).sort() } : {}),
  };
}
