// @effect-diagnostics nodeBuiltinImport:off -- Read-only scan of the real provider homes.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { parse as parseToml } from "smol-toml";
import type {
  AgentProfileInventory,
  AgentProfileInventoryItem,
  AgentProfileProvider,
  SkillSetSkill,
} from "@t3tools/contracts";
import { scanSkills } from "./sync.ts";
import {
  flattenHooks,
  hookDetail,
  mcpDetail,
  readMcpServers,
  type HookGroup,
  type McpServerSpec,
} from "./profileParts.ts";

/** Where each provider keeps its setup. Every path is only read. */
export interface InventoryPaths {
  readonly claudeHome: string;
  readonly claudeJson: string;
  /** Managed settings files or `managed-settings.d` folders. */
  readonly claudePolicy: readonly string[];
  readonly codexHome: string;
  /** `~/.agents`, whose `skills` Codex also loads. */
  readonly agentsHome: string;
  readonly codexPolicy: readonly string[];
  readonly geminiHome: string;
}

export function defaultInventoryPaths(
  userHome: string,
  platform: string,
  environment: Readonly<Record<string, string | undefined>>,
): InventoryPaths {
  const claudeHome = environment.CLAUDE_CONFIG_DIR || NodePath.join(userHome, ".claude");
  const claudeManaged =
    platform === "win32"
      ? NodePath.join(environment.ProgramFiles || "C:\\Program Files", "ClaudeCode")
      : platform === "darwin"
        ? "/Library/Application Support/ClaudeCode"
        : "/etc/claude-code";
  return {
    claudeHome,
    claudeJson: environment.CLAUDE_CONFIG_DIR
      ? NodePath.join(claudeHome, ".claude.json")
      : NodePath.join(userHome, ".claude.json"),
    claudePolicy: [
      NodePath.join(claudeManaged, "managed-settings.json"),
      NodePath.join(claudeManaged, "managed-settings.d"),
    ],
    codexHome: environment.CODEX_HOME || NodePath.join(userHome, ".codex"),
    agentsHome: NodePath.join(userHome, ".agents"),
    codexPolicy:
      platform === "win32"
        ? [
            NodePath.join(
              environment.ProgramData || "C:\\ProgramData",
              "OpenAI",
              "Codex",
              "hooks.json",
            ),
          ]
        : [],
    geminiHome: NodePath.join(userHome, ".gemini"),
  };
}

/** What a reference resolves to at build time. Never sent to clients (MCP `env` lives here). */
export type InventoryPayload =
  | { readonly kind: "instructions"; readonly path: string; readonly text: string }
  | { readonly kind: "skill"; readonly skill: SkillSetSkill }
  | { readonly kind: "plugin"; readonly id: string }
  | {
      readonly kind: "hook";
      readonly group: HookGroup;
      /** Set for a machine-policy hook: the policy file it comes from. */
      readonly policyFile?: string;
    }
  | { readonly kind: "mcp"; readonly name: string; readonly spec: McpServerSpec };
export interface InventoryRecord extends AgentProfileInventoryItem {
  readonly payload: InventoryPayload;
}
export interface MachineInventory {
  readonly providers: ReadonlyArray<{
    readonly provider: AgentProfileProvider;
    readonly home: string;
    readonly items: readonly InventoryRecord[];
    readonly errors: readonly string[];
  }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class Reader {
  readonly items: InventoryRecord[] = [];
  readonly errors: string[] = [];
  readonly provider: AgentProfileProvider;
  constructor(provider: AgentProfileProvider) {
    this.provider = provider;
  }
  async text(path: string): Promise<string | undefined> {
    try {
      return await NodeFSP.readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.errors.push(`${path}: ${String(error)}`);
      return undefined;
    }
  }
  async json(path: string): Promise<unknown> {
    const text = await this.text(path);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch (error) {
      this.errors.push(`${path}: ${String(error)}`);
      return undefined;
    }
  }
  async toml(path: string): Promise<Record<string, unknown> | undefined> {
    const text = await this.text(path);
    if (text === undefined) return undefined;
    try {
      return parseToml(text) as Record<string, unknown>;
    } catch (error) {
      this.errors.push(`${path}: ${String(error)}`);
      return undefined;
    }
  }
  add(
    kind: InventoryRecord["kind"],
    key: string,
    name: string,
    payload: InventoryPayload,
    detail: InventoryRecord["detail"],
    options: { readonly enabled?: boolean; readonly machinePolicy?: boolean } = {},
  ) {
    const id = `${this.provider}:${kind}:${key}`;
    if (this.items.some((item) => item.id === id)) return;
    this.items.push({
      id,
      provider: this.provider,
      kind,
      name,
      enabled: options.enabled ?? true,
      source: options.machinePolicy ? "machine-policy" : "user",
      detail,
      payload,
    });
  }
  async instructions(path: string) {
    const text = await this.text(path);
    const name = NodePath.basename(path);
    if (text !== undefined)
      this.add("instructions", name, name, { kind: "instructions", path, text }, { path, text });
  }
  async skills(root: string) {
    const skills = await scanSkills(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") this.errors.push(`${root}: ${String(error)}`);
      return [];
    });
    for (const skill of skills)
      this.add(
        "skill",
        skill.name,
        skill.name,
        { kind: "skill", skill },
        { path: NodePath.join(skill.targetPath, "SKILL.md"), description: skill.description },
      );
  }
  hooks(native: unknown, keyPrefix: string, policyFile?: string) {
    for (const group of flattenHooks(this.provider, native))
      this.add(
        "hook",
        [keyPrefix, ...group.path, group.index].filter((part) => part !== "").join(":"),
        `${group.path.join(" / ")} #${group.index + 1}`,
        policyFile ? { kind: "hook", group, policyFile } : { kind: "hook", group },
        policyFile ? { ...hookDetail(group), path: policyFile } : hookDetail(group),
        { machinePolicy: policyFile !== undefined },
      );
  }
  mcp(value: unknown, enabled: (spec: McpServerSpec) => boolean = () => true) {
    for (const [name, spec] of Object.entries(readMcpServers(value)))
      this.add("mcp", name, name, { kind: "mcp", name, spec }, mcpDetail(spec), {
        enabled: enabled(spec),
      });
  }
  async policyHooks(paths: readonly string[], settingsKey: boolean) {
    for (const path of paths) {
      const info = await NodeFSP.stat(path).catch(() => undefined);
      const files = info?.isDirectory()
        ? (await NodeFSP.readdir(path))
            .filter((name) => name.endsWith(".json"))
            .sort()
            .map((name) => NodePath.join(path, name))
        : info
          ? [path]
          : [];
      for (const file of files) {
        const value = await this.json(file);
        const hooks = settingsKey && isRecord(value) ? value.hooks : value;
        this.hooks(hooks, `policy:${NodePath.basename(file)}`, file);
      }
    }
  }
}

async function readClaude(paths: InventoryPaths) {
  const reader = new Reader("claude");
  await reader.instructions(NodePath.join(paths.claudeHome, "CLAUDE.md"));
  await reader.skills(paths.claudeHome);
  const settings = await reader.json(NodePath.join(paths.claudeHome, "settings.json"));
  const enabled =
    isRecord(settings) && isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const installed = await reader.json(
    NodePath.join(paths.claudeHome, "plugins", "installed_plugins.json"),
  );
  const installs = isRecord(installed) && isRecord(installed.plugins) ? installed.plugins : {};
  for (const id of [...new Set([...Object.keys(installs), ...Object.keys(enabled)])].sort()) {
    const install = Array.isArray(installs[id]) ? installs[id][0] : undefined;
    reader.add(
      "plugin",
      id,
      id,
      { kind: "plugin", id },
      {
        ...(isRecord(install) && typeof install.installPath === "string"
          ? { path: install.installPath }
          : {}),
        ...(isRecord(install) && typeof install.version === "string"
          ? { version: install.version }
          : {}),
      },
      { enabled: enabled[id] === true },
    );
  }
  if (isRecord(settings)) reader.hooks(settings.hooks, "");
  await reader.policyHooks(paths.claudePolicy, true);
  reader.mcp(await reader.json(paths.claudeJson));
  return reader;
}

async function readCodex(paths: InventoryPaths) {
  const reader = new Reader("codex");
  await reader.instructions(NodePath.join(paths.codexHome, "AGENTS.md"));
  await reader.skills(paths.codexHome);
  await reader.skills(paths.agentsHome);
  const config = (await reader.toml(NodePath.join(paths.codexHome, "config.toml"))) ?? {};
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  for (const [id, value] of Object.entries(plugins).sort(([a], [b]) => a.localeCompare(b)))
    reader.add(
      "plugin",
      id,
      id,
      { kind: "plugin", id },
      {},
      {
        enabled: !isRecord(value) || value.enabled !== false,
      },
    );
  reader.hooks(await reader.json(NodePath.join(paths.codexHome, "hooks.json")), "");
  if (Array.isArray(config.notify)) {
    // Codex runs `notify` at turn end; the profile's Hooks part owns it.
    const group = { path: ["notify"], index: 0, group: config.notify };
    reader.add(
      "hook",
      "notify",
      "notify",
      { kind: "hook", group },
      {
        event: "notify",
        commands: [config.notify.map(String).join(" ")],
      },
    );
  }
  await reader.policyHooks(paths.codexPolicy, false);
  reader.mcp(
    { mcpServers: config.mcp_servers },
    (spec) => !isRecord(spec) || spec.enabled !== false,
  );
  return reader;
}

async function readAntigravity(paths: InventoryPaths) {
  const reader = new Reader("antigravity");
  const config = NodePath.join(paths.geminiHome, "config");
  await reader.instructions(NodePath.join(paths.geminiHome, "GEMINI.md"));
  await reader.instructions(NodePath.join(paths.geminiHome, "AGENTS.md"));
  await reader.skills(config);
  const settings = await reader.json(NodePath.join(config, "config.json"));
  const states = isRecord(settings) && isRecord(settings.plugins) ? settings.plugins : {};
  const folders = await NodeFSP.readdir(NodePath.join(config, "plugins"), {
    withFileTypes: true,
  }).catch(() => []);
  for (const folder of folders.filter((entry) => entry.isDirectory())) {
    const state = states[folder.name];
    reader.add(
      "plugin",
      folder.name,
      folder.name,
      { kind: "plugin", id: folder.name },
      { path: NodePath.join(config, "plugins", folder.name) },
      { enabled: !isRecord(state) || state.enabled !== false },
    );
  }
  reader.hooks(await reader.json(NodePath.join(config, "hooks.json")), "");
  reader.mcp(await reader.json(NodePath.join(config, "mcp_config.json")));
  return reader;
}

/** Reads the real setup of every supported provider. Never writes. */
export async function readMachineInventory(paths: InventoryPaths): Promise<MachineInventory> {
  const [claude, codex, antigravity] = await Promise.all([
    readClaude(paths),
    readCodex(paths),
    readAntigravity(paths),
  ]);
  return {
    providers: [
      { provider: "claude", home: paths.claudeHome, items: claude.items, errors: claude.errors },
      { provider: "codex", home: paths.codexHome, items: codex.items, errors: codex.errors },
      {
        provider: "antigravity",
        home: paths.geminiHome,
        items: antigravity.items,
        errors: antigravity.errors,
      },
    ],
  };
}

export function publicInventory(inventory: MachineInventory): AgentProfileInventory {
  return {
    providers: inventory.providers.map((provider) => ({
      ...provider,
      items: provider.items.map(({ payload: _payload, ...item }) => item),
    })),
  };
}
