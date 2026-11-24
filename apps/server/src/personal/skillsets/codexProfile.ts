// @effect-diagnostics nodeBuiltinImport:off -- Pure path arithmetic on Codex hook keys.
import * as NodePath from "node:path";
import type * as Schema from "effect/Schema";
import type { OwnedEntries } from "./home.ts";
import type { McpServerSpec } from "./profileParts.ts";
import type { ResolvedAgentProfile } from "./profile.ts";

/** One `config/batchWrite` edit. Every profile-owned key is replaced whole; `null` removes it. */
export interface CodexConfigEdit {
  readonly keyPath: string;
  readonly mergeStrategy: "replace";
  readonly value: Schema.Json;
}
/** The fields of a Codex `hooks/list` entry this file reads. */
export interface CodexHookListing {
  readonly key: string;
  readonly source: string;
  readonly sourcePath: string;
  readonly currentHash: string;
  readonly command?: string | undefined;
  readonly pluginId?: string | null | undefined;
  readonly enabled: boolean;
  readonly trustStatus: string;
}
/** What a working directory adds from the repo: what "ignore project instructions" switches off. */
export interface CodexProjectInventory {
  readonly repoSkillPaths: readonly string[];
  readonly projectMcpServers: readonly string[];
  readonly projectHookKeys: readonly string[];
  /** Other keys the repo config sets, with the value to use instead (the user value, else empty). */
  readonly configOverrides?: Readonly<Record<string, unknown>>;
}

const json = (value: unknown): Schema.Json => JSON.parse(JSON.stringify(value ?? null));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Built-home entries Codex reads from `CODEX_HOME` that belong to the profile (lead decision 9). */
export function codexOwnedEntries(
  profile: ResolvedAgentProfile,
  realConfig: string | null,
): OwnedEntries {
  return {
    "AGENTS.md": profile.instructions
      ? { kind: "file", contents: profile.instructions.text }
      : null,
    "AGENTS.override.md": null,
    "hooks.json": profile.hooksFile
      ? { kind: "file", contents: `${JSON.stringify(profile.hooksFile, null, 2)}\n` }
      : null,
    // A byte copy; `config/batchWrite` then swaps in the profile's keys (see codexProfileConfigEdits).
    "config.toml": { kind: "file", contents: realConfig ?? "" },
  };
}

/** `mcp.json` shape to a Codex `[mcp_servers.<name>]` table. */
function codexMcpServer(spec: McpServerSpec) {
  const { type: _type, headers, ...rest } = spec;
  return json(
    headers === undefined || rest.http_headers !== undefined
      ? rest
      : { ...rest, http_headers: headers },
  );
}

const keyFile = (key: string) => key.replace(/(:[^:\\/]+){3}$/, "");
const samePath = (left: string, right: string) =>
  NodePath.resolve(left).toLowerCase() === NodePath.resolve(right).toLowerCase();

export function codexProfileConfigEdits(input: {
  readonly profile: ResolvedAgentProfile;
  readonly realHome: string;
  readonly homePath: string;
  readonly skillRules: ReadonlyArray<{ readonly path: string; readonly enabled: boolean }>;
  readonly hooks: readonly CodexHookListing[];
  /** `hooks.state` of the user config layer. */
  readonly hooksState: unknown;
  /** `plugins` of the user config layer. */
  readonly userPlugins?: unknown;
}): CodexConfigEdit[] {
  const { profile } = input;
  const replace = (keyPath: string, value: unknown): CodexConfigEdit => ({
    keyPath,
    mergeStrategy: "replace",
    value: json(value),
  });
  const userFiles = [input.realHome, input.homePath].flatMap((home) => [
    NodePath.join(home, "hooks.json"),
    NodePath.join(home, "config.toml"),
  ]);
  const realState = isRecord(input.hooksState) ? input.hooksState : {};
  // Keep trust for hooks outside the user hook files (project, plugins); the profile owns the rest.
  const state: Record<string, unknown> = Object.fromEntries(
    Object.entries(realState).filter(
      ([key]) => !userFiles.some((file) => samePath(keyFile(key), file)),
    ),
  );
  const trustedHashes = new Set(
    Object.values(realState).flatMap((row) =>
      isRecord(row) && typeof row.trusted_hash === "string" ? [row.trusted_hash] : [],
    ),
  );
  for (const hook of input.hooks) {
    const profileHook =
      hook.source === "user" &&
      samePath(hook.sourcePath, NodePath.join(input.homePath, "hooks.json"));
    const profilePlugin =
      hook.source === "plugin" &&
      hook.pluginId != null &&
      profile.plugins.includes(hook.pluginId) &&
      trustedHashes.has(hook.currentHash);
    if (profileHook || profilePlugin) state[hook.key] = { trusted_hash: hook.currentHash };
  }
  const notify = profile.hooks.find((hook) => hook.path.length === 1 && hook.path[0] === "notify");
  const servers = Object.entries(profile.mcpServers);
  // Bundled plugins ship inside the CLI, like Claude's built-in plugins: they stay as the user set them.
  const plugins: Record<string, unknown> = Object.fromEntries(
    Object.entries(isRecord(input.userPlugins) ? input.userPlugins : {}).filter(([id]) =>
      id.endsWith("@openai-bundled"),
    ),
  );
  for (const id of profile.plugins) plugins[id] = { enabled: true };
  return [
    replace(
      "mcp_servers",
      servers.length
        ? Object.fromEntries(servers.map(([name, spec]) => [name, codexMcpServer(spec)]))
        : null,
    ),
    replace("plugins", Object.keys(plugins).length ? plugins : null),
    // ChatGPT connectors and remote plugins come from the account, not the profile.
    replace("features.apps", false),
    replace("features.remote_plugin", false),
    replace("skills.config", input.skillRules.length ? input.skillRules : null),
    replace("hooks", Object.keys(state).length ? { state } : null),
    replace("notify", notify?.group ?? null),
  ];
}

/**
 * `--disable hooks` also stops Codex's machine-policy hooks, which no config key can switch off. Use
 * it only when nothing this process should run is a hook (lead decision 14); otherwise the guards
 * stand down through `machinePolicyHooksEnvironment`.
 */
export function codexProfileDisablesHooks(
  profile: ResolvedAgentProfile,
  hooks: readonly CodexHookListing[],
): boolean {
  if (profile.hooksFile !== null) return false;
  const off = new Set(profile.machinePolicyHooksOff.flatMap((hook) => hook.commands));
  return hooks.every((hook) => {
    if (hook.trustStatus === "managed") return hook.command !== undefined && off.has(hook.command);
    if (hook.source === "plugin")
      return hook.pluginId == null || !profile.plugins.includes(hook.pluginId);
    if (hook.source === "project") return !hook.enabled || hook.trustStatus !== "trusted";
    return true;
  });
}

/** Per-thread `config` that hides the repo from one Codex thread (lead decisions 4 and 9). */
export function codexIgnoreProjectConfig(
  project: CodexProjectInventory,
): Record<string, Schema.Json> {
  return {
    ...Object.fromEntries(
      Object.entries(project.configOverrides ?? {}).map(([key, value]) => [key, json(value)]),
    ),
    project_doc_max_bytes: 0,
    ...(project.repoSkillPaths.length
      ? { "skills.config": project.repoSkillPaths.map((path) => ({ path, enabled: false })) }
      : {}),
    // Codex splits thread config keys on dots, so a dotted server name cannot be addressed.
    ...Object.fromEntries(
      project.projectMcpServers
        .filter((name) => !name.includes("."))
        .map((name) => [`mcp_servers.${name}.enabled`, false]),
    ),
    ...(project.projectHookKeys.length
      ? {
          hooks: {
            state: Object.fromEntries(
              project.projectHookKeys.map((key) => [key, { enabled: false }]),
            ),
          },
        }
      : {}),
  };
}

/**
 * Launch flag marking the project folders untrusted for the whole process, so Codex loads none of the
 * repo's `.codex/config.toml` keys, hooks or instruction files (Neon review, mitigation B, measured).
 * Repo skills still load when untrusted; `codexIgnoreProjectConfig` drops them per thread.
 */
export function codexUntrustedProjectsArg(directories: readonly string[]): string {
  if (!directories.length) return "";
  const key = (directory: string) =>
    directory.includes("'") ? JSON.stringify(directory) : `'${directory}'`;
  const rows = directories.map((directory) => `${key(directory)}={trust_level="untrusted"}`);
  const value = `projects={${rows.join(",")}}`;
  // One TOML value is quoted as one CLI argument; user launch flags remain intact.
  return `-c "${value.replace(/["\\$`]/g, "\\$&")}"`;
}
