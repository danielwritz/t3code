import type { OwnedEntries } from "./home.ts";
import type { ResolvedAgentProfile } from "./profile.ts";
import type { McpServerSpec } from "./profileParts.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Root entries of the built `--gemini-dir`. agy loads root `GEMINI.md` and `AGENTS.md` as global
 * rules and scans root `skills/`, so none of them may come from the instance folder.
 */
export function antigravityOwnedEntries(profile: ResolvedAgentProfile): OwnedEntries {
  return {
    "GEMINI.md": profile.instructions
      ? { kind: "file", contents: profile.instructions.text }
      : null,
    "AGENTS.md": null,
    skills: null,
  };
}

/** `config/mcp_config.json`: stdio keeps command, args and env; HTTP keeps url and headers. */
export function antigravityMcpConfig(servers: Readonly<Record<string, McpServerSpec>>): string {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const [name, spec] of Object.entries(servers)) {
    if (typeof spec.url === "string") {
      mcpServers[name] = {
        url: spec.url,
        ...(isRecord(spec.headers) ? { headers: spec.headers } : {}),
      };
    } else if (typeof spec.command === "string") {
      mcpServers[name] = {
        command: spec.command,
        ...(Array.isArray(spec.args) ? { args: spec.args.map(String) } : {}),
        ...(isRecord(spec.env) ? { env: spec.env } : {}),
      };
    }
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

/**
 * `config/config.json`: every key from the instance's file, with a `plugins` map that turns on
 * exactly the profile's plugins. Installed plugin folders not in the profile are switched off;
 * built-in plugins (such as `swarm`) are left out so they keep agy's default.
 */
export function antigravityPluginConfig(input: {
  readonly instanceConfig: string | undefined;
  readonly pluginFolders: readonly string[];
  readonly enabled: readonly string[];
}): string {
  let base: Record<string, unknown> = {};
  try {
    const parsed: unknown = input.instanceConfig ? JSON.parse(input.instanceConfig) : {};
    if (isRecord(parsed)) base = parsed;
  } catch {
    base = {};
  }
  const plugins: Record<string, { enabled: boolean }> = {};
  for (const folder of [...input.pluginFolders].toSorted())
    plugins[folder] = { enabled: input.enabled.includes(folder) };
  for (const id of input.enabled) plugins[id] = { enabled: true };
  return `${JSON.stringify({ ...base, plugins }, null, 2)}\n`;
}

/** `config/hooks.json` from the profile, or undefined when the profile has no hooks. */
export function antigravityHooksConfig(profile: ResolvedAgentProfile): string | undefined {
  return profile.hooksFile ? `${JSON.stringify(profile.hooksFile, null, 2)}\n` : undefined;
}
