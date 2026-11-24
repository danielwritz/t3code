// @effect-diagnostics nodeBuiltinImport:off -- Reads a profile folder; never writes it.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  AGENT_PROFILE_PROVIDERS,
  type AgentProfileItem,
  type AgentProfileProvider,
  type AgentProfileView,
  type SkillSetSkill,
} from "@t3tools/contracts";
import type { InventoryPayload, MachineInventory } from "./inventory.ts";
import {
  assembleHooks,
  flattenHooks,
  hookDetail,
  mcpDetail,
  readMcpServers,
  type HookGroup,
  type McpServerSpec,
} from "./profileParts.ts";

/** Profile folder files (lead decision 1). Every part is optional. */
const INSTRUCTION_FILES: ReadonlyArray<readonly [string, AgentProfileProvider | null]> = [
  ["CLAUDE.md", "claude"],
  ["AGENTS.md", "codex"],
  ["GEMINI.md", "antigravity"],
  ["instructions.md", null],
];
export const PROFILE_REFERENCES_FILE = "refs.json";

export interface ProfileFolder {
  readonly root: string;
  readonly instructions: ReadonlyArray<{
    readonly file: string;
    readonly provider: AgentProfileProvider | null;
    readonly path: string;
    readonly text: string;
  }>;
  readonly plugins: Partial<Record<AgentProfileProvider, readonly string[]>>;
  readonly hooks: Partial<Record<AgentProfileProvider, readonly HookGroup[]>>;
  readonly mcp: Readonly<Record<string, McpServerSpec>>;
  readonly references: readonly string[];
  readonly errors: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function readProfileFolder(root: string): Promise<ProfileFolder> {
  const errors: string[] = [];
  const text = async (relative: string) => {
    try {
      return await NodeFSP.readFile(NodePath.join(root, relative), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        errors.push(`${relative}: ${String(error)}`);
      return undefined;
    }
  };
  const json = async (relative: string): Promise<unknown> => {
    const value = await text(relative);
    if (value === undefined) return undefined;
    try {
      return JSON.parse(value);
    } catch (error) {
      errors.push(`${relative}: ${String(error)}`);
      return undefined;
    }
  };
  const instructions: Array<ProfileFolder["instructions"][number]> = [];
  for (const [file, provider] of INSTRUCTION_FILES) {
    const value = await text(file);
    if (value !== undefined)
      instructions.push({ file, provider, path: NodePath.join(root, file), text: value });
  }
  const pluginFile = await json("plugins.json");
  const plugins: Partial<Record<AgentProfileProvider, readonly string[]>> = {};
  const hooks: Partial<Record<AgentProfileProvider, readonly HookGroup[]>> = {};
  for (const provider of AGENT_PROFILE_PROVIDERS) {
    const ids = isRecord(pluginFile) ? pluginFile[provider] : undefined;
    if (Array.isArray(ids)) plugins[provider] = ids.filter((id) => typeof id === "string");
    const native = await json(NodePath.join("hooks", `${provider}.json`));
    if (native !== undefined) hooks[provider] = flattenHooks(provider, native);
  }
  const referenceFile = await json(PROFILE_REFERENCES_FILE);
  const references = (Array.isArray(referenceFile) ? referenceFile : [])
    .map((entry) => (isRecord(entry) && typeof entry.ref === "string" ? entry.ref : undefined))
    .filter((ref): ref is string => ref !== undefined);
  return {
    root,
    instructions,
    plugins,
    hooks,
    mcp: readMcpServers(await json("mcp.json")),
    references,
    errors,
  };
}

/** A profile row plus what it applies. The payload never goes to clients. */
export interface ProfileItemRecord extends AgentProfileItem {
  readonly payload?: InventoryPayload;
}
/** The per-profile overlay kept in the side file (lead decision 12). */
export interface ProfileOverlay {
  readonly disabledSkills: readonly string[];
  readonly disabledItems?: readonly string[] | undefined;
  /** Machine-policy hook items switched on; they are off unless listed here or referenced. */
  readonly enabledItems?: readonly string[] | undefined;
}

export function profileItems(input: {
  readonly folder: ProfileFolder;
  readonly skills: readonly SkillSetSkill[];
  readonly overlay: ProfileOverlay;
  readonly inventory?: MachineInventory | undefined;
}): { readonly items: readonly ProfileItemRecord[]; readonly errors: readonly string[] } {
  const disabled = new Set(input.overlay.disabledItems ?? []);
  const errors = [...input.folder.errors];
  const items: ProfileItemRecord[] = [];
  const add = (item: Omit<ProfileItemRecord, "enabled" | "origin">, enabled = true) =>
    items.push({ ...item, origin: "profile", enabled: enabled && !disabled.has(item.id) });
  const inventoryItem = (provider: AgentProfileProvider, kind: string, key: string) =>
    input.inventory?.providers
      .find((entry) => entry.provider === provider)
      ?.items.find((item) => item.id === `${provider}:${kind}:${key}`);
  for (const file of input.folder.instructions)
    add({
      id: `instructions:${file.file}`,
      kind: "instructions",
      provider: file.provider,
      name: file.file,
      detail: { path: file.path, text: file.text },
      payload: { kind: "instructions", path: file.path, text: file.text },
    });
  for (const skill of input.skills)
    add(
      {
        id: `skill:${skill.name}`,
        kind: "skill",
        provider: null,
        name: skill.name,
        detail: {
          path: NodePath.join(skill.targetPath, "SKILL.md"),
          description: skill.description,
        },
        payload: { kind: "skill", skill },
      },
      !input.overlay.disabledSkills.includes(skill.name),
    );
  for (const provider of AGENT_PROFILE_PROVIDERS) {
    for (const id of input.folder.plugins[provider] ?? [])
      add({
        id: `plugin:${provider}:${id}`,
        kind: "plugin",
        provider,
        name: id,
        detail: inventoryItem(provider, "plugin", id)?.detail ?? {},
        payload: { kind: "plugin", id },
      });
    for (const group of input.folder.hooks[provider] ?? [])
      add({
        id: `hook:${provider}:${[...group.path, group.index].join(":")}`,
        kind: "hook",
        provider,
        name: `${group.path.join(" / ")} #${group.index + 1}`,
        detail: hookDetail(group),
        payload: { kind: "hook", group },
      });
  }
  for (const [name, spec] of Object.entries(input.folder.mcp))
    add({
      id: `mcp:${name}`,
      kind: "mcp",
      provider: null,
      name,
      detail: mcpDetail(spec),
      payload: { kind: "mcp", name, spec },
    });
  // Lead decision 14: machine-policy hooks are listed in every profile and are off unless switched on.
  const switchedOn = new Set(input.overlay.enabledItems ?? []);
  for (const item of input.inventory?.providers.flatMap((entry) => entry.items) ?? []) {
    if (item.source !== "machine-policy") continue;
    const id = `policy:${item.id}`;
    items.push({
      id,
      kind: item.kind,
      provider: item.provider,
      name: item.name,
      enabled:
        (switchedOn.has(id) || input.folder.references.includes(item.id)) && !disabled.has(id),
      origin: "machine-policy",
      reference: item.id,
      detail: item.detail,
      payload: item.payload,
    });
  }
  for (const reference of input.folder.references) {
    const id = `ref:${reference}`;
    const [provider] = reference.split(":");
    const found = input.inventory?.providers
      .flatMap((entry) => entry.items)
      .find((item) => item.id === reference);
    if (found?.source === "machine-policy") continue;
    if (!found) {
      errors.push(`Reference ${reference} was not found on this machine`);
      items.push({
        id,
        kind: "instructions",
        provider: (AGENT_PROFILE_PROVIDERS as readonly string[]).includes(provider ?? "")
          ? (provider as AgentProfileProvider)
          : null,
        name: reference,
        enabled: false,
        origin: "reference",
        reference,
        missing: true,
        detail: {},
      });
      continue;
    }
    items.push({
      id,
      kind: found.kind,
      // Skills and MCP servers are one list for every provider; the rest belong to their provider.
      provider: found.kind === "skill" || found.kind === "mcp" ? null : found.provider,
      name: found.name,
      enabled: !disabled.has(id),
      origin: "reference",
      reference,
      detail: found.detail,
      payload: found.payload,
    });
  }
  return { items, errors };
}

export function profileView(input: {
  readonly id: string;
  readonly name: string;
  readonly root: string | null;
  readonly ignoreProjectInstructions: boolean;
  readonly items: readonly ProfileItemRecord[];
  readonly errors: readonly string[];
}): AgentProfileView {
  return {
    ...input,
    items: input.items.map(({ payload: _payload, ...item }) => item),
  };
}

/** Everything one provider applies for one profile. Drivers receive this and nothing else. */
export interface ResolvedAgentProfile {
  readonly profileId: string;
  readonly provider: AgentProfileProvider;
  /** The profile folder (or git checkout); read-only. */
  readonly root: string;
  /** The thread's choice when it has one, else the profile's. */
  readonly ignoreProjectInstructions: boolean;
  /** The provider's own file, else a reference to the real one, else `instructions.md`. */
  readonly instructions: {
    readonly itemId: string;
    readonly path: string;
    readonly text: string;
  } | null;
  readonly skills: readonly SkillSetSkill[];
  readonly plugins: readonly string[];
  readonly hooks: ReadonlyArray<HookGroup & { readonly itemId: string }>;
  /**
   * `hooks` in the provider's own format (see `assembleHooks`); null when there are none. Codex
   * `notify` (path `["notify"]`) is in `hooks` only: it belongs in `config.toml`.
   */
  readonly hooksFile: Record<string, unknown> | null;
  /**
   * Machine-policy hooks of this provider that the profile has switched off. The machine still
   * runs them; `openHookSwitchSession` (runtime.ts) tells their guards to stand down.
   */
  readonly machinePolicyHooksOff: readonly MachinePolicyHookOff[];
  /** Profile MCP servers by name, with `env` values from references (build time only). */
  readonly mcpServers: Readonly<Record<string, McpServerSpec>>;
  /** Changes whenever anything above changes; part of the session identity. */
  readonly contentHash: string;
}

export function resolveAgentProfile(input: {
  readonly profileId: string;
  readonly provider: AgentProfileProvider;
  readonly root: string;
  readonly items: readonly ProfileItemRecord[];
  readonly ignoreProjectInstructions: boolean;
}): ResolvedAgentProfile {
  const enabled = input.items.filter((item) => item.enabled && item.payload);
  const own = enabled.filter((item) => item.provider === input.provider);
  const shared = enabled.filter((item) => item.provider === null);
  const instruction = [...own, ...shared].find((item) => item.kind === "instructions");
  const skills = new Map<string, SkillSetSkill>();
  const mcpServers: Record<string, McpServerSpec> = {};
  for (const item of shared) {
    const payload = item.payload!;
    if (payload.kind === "skill" && !skills.has(payload.skill.name))
      skills.set(payload.skill.name, payload.skill);
    if (payload.kind === "mcp" && !(payload.name in mcpServers))
      mcpServers[payload.name] = payload.spec;
  }
  const plugins = [
    ...new Set(own.flatMap((item) => (item.payload!.kind === "plugin" ? [item.payload!.id] : []))),
  ];
  const hooks = own.flatMap((item) =>
    item.payload!.kind === "hook" && item.origin !== "machine-policy"
      ? [{ ...item.payload!.group, itemId: item.id }]
      : [],
  );
  // Codex `notify` is a config.toml key, not a hooks.json entry.
  const fileHooks = hooks.filter(
    (hook) => !(input.provider === "codex" && hook.path.length === 1 && hook.path[0] === "notify"),
  );
  const machinePolicyHooksOff = input.items.flatMap((item): MachinePolicyHookOff[] =>
    item.origin === "machine-policy" &&
    !item.enabled &&
    item.provider === input.provider &&
    item.payload?.kind === "hook"
      ? [
          {
            id: item.reference!,
            file: item.payload.policyFile ?? "",
            event: item.detail.event ?? "",
            ...(item.detail.matcher === undefined ? {} : { matcher: item.detail.matcher }),
            commands: item.detail.commands ?? [],
            guardId: machinePolicyHookId(item.detail.commands ?? []),
          },
        ]
      : [],
  );
  const instructions =
    instruction?.payload?.kind === "instructions"
      ? { itemId: instruction.id, path: instruction.payload.path, text: instruction.payload.text }
      : null;
  const parts = {
    profileId: input.profileId,
    provider: input.provider,
    root: input.root,
    ignoreProjectInstructions: input.ignoreProjectInstructions,
    instructions,
    skills: [...skills.values()],
    plugins,
    hooks,
    hooksFile: fileHooks.length ? assembleHooks(input.provider, fileHooks) : null,
    machinePolicyHooksOff,
    mcpServers,
  };
  return {
    ...parts,
    contentHash: NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex"),
  };
}

export interface MachinePolicyHookOff {
  /** Inventory id, for example `codex:hook:policy:hooks.json:PreToolUse:0`. */
  readonly id: string;
  /** The policy file the hook is defined in. */
  readonly file: string;
  readonly event: string;
  readonly matcher?: string;
  readonly commands: readonly string[];
  /** The id the guard scripts match (`machinePolicyHookId`). */
  readonly guardId: string;
}

const INTERPRETERS = new Set([
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "py",
  "bash",
  "sh",
  "pwsh",
  "powershell",
  "cmd",
]);
const scriptName = (path: string) => {
  const base = path.split(/[\\/]/).at(-1) ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};
/**
 * A machine-policy hook's id, shared with the guard scripts: the file name, without extension, of
 * the script its first command runs (`node "...\outside-post-guard.mjs"` is `outside-post-guard`).
 */
export function machinePolicyHookId(commands: readonly string[]): string {
  const tokens = [...(commands[0] ?? "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
  const [first, ...rest] = tokens;
  if (first === undefined) return "";
  if (!INTERPRETERS.has(scriptName(first).toLowerCase())) return scriptName(first);
  // Skip switches: `-File`, `--flag`, and short Windows ones such as `/c`.
  const script = rest.find((token) => !token.startsWith("-") && !/^\/\w{1,2}$/.test(token));
  return script === undefined ? scriptName(first) : scriptName(script);
}
