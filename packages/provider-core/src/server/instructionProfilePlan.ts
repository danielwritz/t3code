import {
  INSTRUCTION_PROFILE_ALL_ITEMS,
  ProviderDriverKind,
  type InstructionProfile,
  type InstructionProfileDriverSupport,
  type InstructionProfileItem,
  type InstructionProfileItemEffect,
  type InstructionProfileItemKind,
} from "@t3tools/contracts";

export const INSTRUCTION_PROFILE_CODEX_CONTEXT_KEY = "t3_code_instruction_profile";
/** Codex silently truncates additionalContext values over 1,000 tokens (UTF-8 bytes / 4). */
const CODEX_CONTEXT_VALUE_MAX_BYTES = 4_000;
/** T3's own MCP servers carry its tools; a profile never removes them. */
const T3_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(["t3-code", "t3-code-direct"]);
const ACP_DRIVERS: ReadonlySet<string> = new Set([
  "antigravity",
  "fx",
  "grok",
  "kiro",
  "acpRegistry",
]);

export interface InstructionProfilePlanContext {
  /** Codex only: MCP server names defined in that home's `config.toml`. */
  readonly codexConfigMcpServers?: ReadonlyArray<string>;
}

export interface ClaudeInstructionProfilePlan {
  /** Leave out T3's own system prompt text and its `t3-code` MCP server. */
  readonly omitHost?: true;
  /** Added after T3's own `systemPrompt.append` text. */
  readonly appendSystemPrompt?: string;
  /** SDK `skills` allow list. */
  readonly skills?: ReadonlyArray<string>;
  readonly strictMcpConfig?: true;
  /** Merged into the flag settings T3 already passes. */
  readonly settings?: {
    readonly skillOverrides?: Readonly<Record<string, "off">>;
    readonly permissionsDeny?: ReadonlyArray<string>;
    readonly deniedMcpServers?: ReadonlyArray<{ readonly serverName: string }>;
  };
}

export interface CodexInstructionProfilePlan {
  /** Leave out T3's own additionalContext entries and its MCP servers. */
  readonly omitHost?: true;
  /** Extra per-turn `additionalContext` entries, kind `application`. */
  readonly additionalContext?: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  /** Merged into the per-thread `config` map of `thread/start|resume|fork`. */
  readonly config?: Readonly<
    Record<string, boolean | ReadonlyArray<{ readonly name: string; readonly enabled: false }>>
  >;
}

export interface AcpInstructionProfilePlan {
  /** Leave out T3's prompt notes, runtime info and `t3-code` MCP server; Plan mode keeps its note. */
  readonly omitHost?: true;
  /** Added to the first prompt beside T3's own instructions. */
  readonly promptPrefix?: string;
}

export interface InstructionProfilePlan {
  readonly effects: ReadonlyArray<InstructionProfileItemEffect>;
  readonly claude?: ClaudeInstructionProfilePlan;
  readonly codex?: CodexInstructionProfilePlan;
  readonly acp?: AcpInstructionProfilePlan;
}

/** The resolved profile and its plan for one driver, as adapters receive it. */
export interface InstructionProfileLaunch {
  readonly profileId: string;
  readonly profileName: string;
  readonly plan: InstructionProfilePlan;
}

const escapeAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function instructionProfileBlock(name: string, text: string): string {
  return `<instruction_profile name="${escapeAttribute(name)}">\n${text.trim()}\n</instruction_profile>`;
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

function splitForCodex(text: string): ReadonlyArray<string> {
  const chunks: Array<string> = [];
  let current = "";
  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = "";
  };
  for (const line of text.split("\n")) {
    const joined = current.length === 0 ? line : `${current}\n${line}`;
    if (utf8Bytes(joined) <= CODEX_CONTEXT_VALUE_MAX_BYTES) {
      current = joined;
      continue;
    }
    flush();
    if (utf8Bytes(line) <= CODEX_CONTEXT_VALUE_MAX_BYTES) {
      current = line;
      continue;
    }
    let piece = "";
    for (const character of line) {
      if (utf8Bytes(piece + character) > CODEX_CONTEXT_VALUE_MAX_BYTES) {
        chunks.push(piece);
        piece = "";
      }
      piece += character;
    }
    current = piece;
  }
  flush();
  return chunks;
}

type Effect = InstructionProfileItemEffect;

const requestedOf = (item: InstructionProfileItem) => (item.enabled ? "on" : "off");

const itemEffect = (
  item: InstructionProfileItem,
  result: Effect["result"],
  how: string,
  reason?: string,
): Effect => ({
  kind: item.kind,
  name: item.name,
  requested: requestedOf(item),
  result,
  how,
  ...(reason === undefined ? {} : { reason }),
});

const ON_BY_DEFAULT = "on by default";
const ALREADY_OFF = (plural: string) => `all ${plural} are already off`;

interface KindGroup {
  readonly all: InstructionProfileItem | undefined;
  readonly allOff: boolean;
}

const groupOf = (
  items: ReadonlyArray<InstructionProfileItem>,
  kind: InstructionProfileItemKind,
) => {
  const all = items.find(
    (item) => item.kind === kind && item.name === INSTRUCTION_PROFILE_ALL_ITEMS,
  );
  return { all, allOff: all?.enabled === false } satisfies KindGroup;
};

const isAll = (item: InstructionProfileItem) => item.name === INSTRUCTION_PROFILE_ALL_ITEMS;

/** Claude Code adds to the skill list it already sent and never takes a skill out of it. */
const SKILL_LIST_TIMING =
  "; the Skill tool refuses it from the next turn, and it leaves the skill list from the next new thread";

function planClaude(profile: InstructionProfile, effects: Array<Effect>): InstructionProfilePlan {
  const items = profile.items;
  const skills = groupOf(items, "skill");
  const agents = groupOf(items, "agent");
  const mcp = groupOf(items, "mcpServer");
  const skillOverrides: Record<string, "off"> = {};
  const permissionsDeny: Array<string> = [];
  const deniedMcpServers: Array<{ readonly serverName: string }> = [];
  const allowedSkills = items
    .filter((item) => item.kind === "skill" && !isAll(item) && item.enabled)
    .map((item) => item.name);
  for (const item of items) {
    if (item.kind === "skill") {
      if (isAll(item)) {
        effects.push(
          item.enabled
            ? itemEffect(item, "skipped", "none", ON_BY_DEFAULT)
            : itemEffect(
                item,
                "applied",
                `SDK option skills=[${allowedSkills.join(", ")}] (allow list)${SKILL_LIST_TIMING}`,
              ),
        );
      } else if (item.enabled) {
        effects.push(
          skills.allOff
            ? itemEffect(item, "applied", "listed in SDK option skills")
            : itemEffect(item, "skipped", "none", ON_BY_DEFAULT),
        );
      } else if (skills.allOff) {
        effects.push(itemEffect(item, "skipped", "none", ALREADY_OFF("skills")));
      } else {
        skillOverrides[item.name] = "off";
        effects.push(
          itemEffect(
            item,
            "applied",
            `flag settings skillOverrides["${item.name}"]="off"${SKILL_LIST_TIMING}`,
          ),
        );
      }
    } else if (item.kind === "agent") {
      if (isAll(item)) {
        if (item.enabled) {
          effects.push(itemEffect(item, "skipped", "none", ON_BY_DEFAULT));
        } else {
          permissionsDeny.push("Agent");
          effects.push(itemEffect(item, "applied", 'flag settings permissions.deny "Agent"'));
        }
      } else if (item.enabled) {
        effects.push(
          agents.allOff
            ? itemEffect(
                item,
                "not-supported",
                "none",
                "all agents are off, and Claude has no agent allow list",
              )
            : itemEffect(item, "skipped", "none", ON_BY_DEFAULT),
        );
      } else if (agents.allOff) {
        effects.push(itemEffect(item, "skipped", "none", ALREADY_OFF("agents")));
      } else {
        permissionsDeny.push(`Agent(${item.name})`);
        effects.push(
          itemEffect(item, "applied", `flag settings permissions.deny "Agent(${item.name})"`),
        );
      }
    } else if (T3_MCP_SERVER_NAMES.has(item.name)) {
      effects.push(itemEffect(item, "skipped", "none", "T3 Code's own server stays on"));
    } else if (isAll(item)) {
      effects.push(
        item.enabled
          ? itemEffect(item, "skipped", "none", ON_BY_DEFAULT)
          : itemEffect(
              item,
              "applied",
              "SDK option strictMcpConfig=true (only T3 Code's servers load)",
            ),
      );
    } else if (item.enabled) {
      effects.push(
        mcp.allOff
          ? itemEffect(
              item,
              "not-supported",
              "none",
              "all MCP servers are off, and Claude cannot turn one back on by name",
            )
          : itemEffect(item, "skipped", "none", ON_BY_DEFAULT),
      );
    } else if (mcp.allOff) {
      effects.push(itemEffect(item, "skipped", "none", ALREADY_OFF("MCP servers")));
    } else {
      deniedMcpServers.push({ serverName: item.name });
      effects.push(
        itemEffect(
          item,
          "applied",
          `flag settings deniedMcpServers [{serverName: "${item.name}"}]`,
        ),
      );
    }
  }
  const settings = {
    ...(Object.keys(skillOverrides).length === 0 ? {} : { skillOverrides }),
    ...(permissionsDeny.length === 0 ? {} : { permissionsDeny }),
    ...(deniedMcpServers.length === 0 ? {} : { deniedMcpServers }),
  };
  const text = profile.globalInstructions.trim();
  const claude: ClaudeInstructionProfilePlan = {
    ...(text.length === 0
      ? {}
      : { appendSystemPrompt: instructionProfileBlock(profile.name, text) }),
    ...(skills.allOff ? { skills: allowedSkills } : {}),
    ...(mcp.allOff ? { strictMcpConfig: true as const } : {}),
    ...(Object.keys(settings).length === 0 ? {} : { settings }),
  };
  return { effects, ...(Object.keys(claude).length === 0 ? {} : { claude }) };
}

/** Codex reads the thread `config` map only in `thread/start`, `thread/resume` and `thread/fork`. */
const CODEX_CONFIG_TIMING =
  "; Codex reads it when it starts or resumes this thread (a new thread, a server restart, or after the idle thread unloads), not while the thread stays loaded";

const PLUGIN_SERVER_REASON = "plugin server: Codex rejects this key and the session fails to open";

function planCodex(
  profile: InstructionProfile,
  context: InstructionProfilePlanContext,
  effects: Array<Effect>,
): InstructionProfilePlan {
  const items = profile.items;
  const skills = groupOf(items, "skill");
  const agents = groupOf(items, "agent");
  const mcp = groupOf(items, "mcpServer");
  const configNames = new Set(context.codexConfigMcpServers ?? []);
  const addressable = (name: string) =>
    configNames.has(name) && !name.includes(".") && !T3_MCP_SERVER_NAMES.has(name);
  const keptOn = new Set(
    items
      .filter((item) => item.kind === "mcpServer" && !isAll(item) && item.enabled)
      .map((item) => item.name),
  );
  const config: Record<
    string,
    boolean | ReadonlyArray<{ readonly name: string; readonly enabled: false }>
  > = {};
  const skillConfig: Array<{ readonly name: string; readonly enabled: false }> = [];
  const disabledServers: Array<string> = [];
  for (const item of items) {
    if (item.kind === "skill") {
      if (isAll(item)) {
        if (item.enabled) {
          effects.push(itemEffect(item, "skipped", "none", ON_BY_DEFAULT));
        } else {
          config["skills.include_instructions"] = false;
          effects.push(itemEffect(item, "applied", "config skills.include_instructions=false"));
        }
      } else if (item.enabled) {
        effects.push(
          skills.allOff
            ? itemEffect(
                item,
                "not-supported",
                "none",
                "all skills are off, and Codex has no skill allow list",
              )
            : itemEffect(item, "skipped", "none", ON_BY_DEFAULT),
        );
      } else if (skills.allOff) {
        effects.push(itemEffect(item, "skipped", "none", ALREADY_OFF("skills")));
      } else {
        skillConfig.push({ name: item.name, enabled: false });
        effects.push(
          itemEffect(
            item,
            "applied",
            `config skills.config=[{name="${item.name}", enabled=false}]`,
          ),
        );
      }
    } else if (item.kind === "agent") {
      if (isAll(item)) {
        if (item.enabled) {
          effects.push(itemEffect(item, "skipped", "none", ON_BY_DEFAULT));
        } else {
          config["agents.enabled"] = false;
          effects.push(itemEffect(item, "applied", "config agents.enabled=false"));
        }
      } else if (agents.allOff) {
        effects.push(
          item.enabled
            ? itemEffect(
                item,
                "not-supported",
                "none",
                "all agents are off, and Codex has no agent allow list",
              )
            : itemEffect(item, "skipped", "none", ALREADY_OFF("agents")),
        );
      } else {
        effects.push(
          item.enabled
            ? itemEffect(item, "skipped", "none", ON_BY_DEFAULT)
            : itemEffect(item, "not-supported", "none", "Codex has no switch for one agent"),
        );
      }
    } else if (T3_MCP_SERVER_NAMES.has(item.name)) {
      effects.push(itemEffect(item, "skipped", "none", "T3 Code's own server stays on"));
    } else if (isAll(item)) {
      if (item.enabled) {
        effects.push(itemEffect(item, "skipped", "none", ON_BY_DEFAULT));
        continue;
      }
      const names = [...configNames].filter((name) => addressable(name) && !keptOn.has(name));
      if (names.length === 0) {
        effects.push(
          itemEffect(
            item,
            "skipped",
            "none",
            "config.toml defines no MCP server Codex can switch off",
          ),
        );
        continue;
      }
      disabledServers.push(...names);
      effects.push(
        itemEffect(
          item,
          "applied",
          `config mcp_servers.<name>.enabled=false for ${names.join(", ")}`,
          "servers from plugins stay on: Codex rejects this key for them and the session fails to open",
        ),
      );
    } else if (item.enabled) {
      effects.push(
        mcp.allOff && addressable(item.name)
          ? itemEffect(item, "skipped", "none", "left out of the servers switched off")
          : mcp.allOff
            ? itemEffect(item, "skipped", "none", "Codex does not switch this server off")
            : itemEffect(item, "skipped", "none", ON_BY_DEFAULT),
      );
    } else if (item.name.includes(".")) {
      effects.push(
        itemEffect(
          item,
          "not-supported",
          "none",
          "a dot in the name cannot be written as a Codex config key",
        ),
      );
    } else if (!configNames.has(item.name)) {
      effects.push(itemEffect(item, "not-supported", "none", PLUGIN_SERVER_REASON));
    } else if (mcp.allOff) {
      effects.push(itemEffect(item, "skipped", "none", ALREADY_OFF("MCP servers")));
    } else {
      disabledServers.push(item.name);
      effects.push(itemEffect(item, "applied", `config mcp_servers.${item.name}.enabled=false`));
    }
  }
  if (skillConfig.length > 0) config["skills.config"] = skillConfig;
  for (const name of disabledServers) config[`mcp_servers.${name}.enabled`] = false;
  const text = profile.globalInstructions.trim();
  const chunks = text.length === 0 ? [] : splitForCodex(text);
  const additionalContext = chunks.map((value, index) => ({
    key:
      chunks.length === 1
        ? INSTRUCTION_PROFILE_CODEX_CONTEXT_KEY
        : `${INSTRUCTION_PROFILE_CODEX_CONTEXT_KEY}_${String(index + 1).padStart(2, "0")}`,
    value,
  }));
  const codex: CodexInstructionProfilePlan = {
    ...(additionalContext.length === 0 ? {} : { additionalContext }),
    ...(Object.keys(config).length === 0 ? {} : { config }),
  };
  const timed = effects.map((effect) =>
    effect.result === "applied" && effect.how.startsWith("config ")
      ? { ...effect, how: `${effect.how}${CODEX_CONFIG_TIMING}` }
      : effect,
  );
  return { effects: timed, ...(Object.keys(codex).length === 0 ? {} : { codex }) };
}

const KIND_PLURAL: Record<InstructionProfileItemKind, string> = {
  skill: "skills",
  agent: "agents",
  mcpServer: "MCP servers",
  host: "T3 Code tools",
};

function planAcp(profile: InstructionProfile, effects: Array<Effect>): InstructionProfilePlan {
  for (const item of profile.items) {
    effects.push(
      itemEffect(
        item,
        "not-supported",
        "none",
        `this agent loads its own ${KIND_PLURAL[item.kind]}, and T3 has no per-session switch for them`,
      ),
    );
  }
  const text = profile.globalInstructions.trim();
  return {
    effects,
    ...(text.length === 0
      ? {}
      : { acp: { promptPrefix: instructionProfileBlock(profile.name, text) } }),
  };
}

const NO_SWITCH = "T3 has no launch-time switch for this provider yet";

type Family = "claude" | "codex" | "acp";

const HOST_HOW: Record<Family, string> = {
  claude:
    "T3 Code's system prompt text (runtime info, pull request linking, orchestration, background wait, send to user, device notes) and its t3-code MCP server are left out; the system prompt is sent fresh on each request (snapshot off), so this applies from the next turn",
  codex:
    "T3 Code's additionalContext entries (orchestration, runtime info, tool notes) are left out from the next turn; its t3-code and t3-code-direct MCP servers are left out when Codex starts or resumes this thread (a new thread, a server restart, or after the idle thread unloads)",
  acp: "T3 Code's first-prompt notes and runtime info are left out from the next turn; its t3-code MCP server is left out when the agent session next starts or loads (a new thread or a server restart); T3 still sends its Plan mode note while the thread is in Plan mode",
};

function planFamily(
  family: Family | undefined,
  profile: InstructionProfile,
  context: InstructionProfilePlanContext,
  effects: Array<Effect>,
): InstructionProfilePlan {
  switch (family) {
    case "claude":
      return planClaude(profile, effects);
    case "codex":
      return planCodex(profile, context, effects);
    case "acp":
      return planAcp(profile, effects);
    default:
      for (const item of profile.items) {
        effects.push(itemEffect(item, "not-supported", "none", NO_SWITCH));
      }
      return { effects };
  }
}

/** Decides, without I/O, which launch-time switches a profile sets for one driver. */
export function planInstructionProfile(
  driver: ProviderDriverKind,
  profile: InstructionProfile,
  context: InstructionProfilePlanContext,
): InstructionProfilePlan {
  const effects: Array<Effect> = [];
  const hasText = profile.globalInstructions.trim().length > 0;
  const family: Family | undefined =
    driver === "claudeAgent"
      ? "claude"
      : driver === "codex"
        ? "codex"
        : ACP_DRIVERS.has(driver)
          ? "acp"
          : undefined;
  if (hasText) {
    effects.push({
      kind: "global-instructions",
      requested: "add",
      result: family === undefined ? "not-supported" : "applied",
      how: family === undefined ? "none" : (SUPPORT_HOW[family]["global-instructions"] ?? "none"),
      ...(family === undefined ? { reason: NO_SWITCH } : {}),
    });
  }
  const hostItems = profile.items.filter((item) => item.kind === "host");
  const plan = planFamily(
    family,
    { ...profile, items: profile.items.filter((item) => item.kind !== "host") },
    context,
    effects,
  );
  const hostEffects = hostItems.map((item) =>
    item.enabled
      ? itemEffect(item, "skipped", "none", ON_BY_DEFAULT)
      : family === undefined
        ? itemEffect(item, "not-supported", "none", NO_SWITCH)
        : itemEffect(item, "applied", HOST_HOW[family]),
  );
  const omitHost = family !== undefined && hostItems.some((item) => !item.enabled);
  return {
    ...plan,
    effects: [...plan.effects, ...hostEffects],
    ...(omitHost ? { [family]: { ...plan[family], omitHost: true } } : {}),
  };
}

type SupportKind = InstructionProfileDriverSupport["kinds"][number]["kind"];
type SupportRow = Record<SupportKind, string | undefined>;

const SUPPORT_HOW: Record<Family, SupportRow> = {
  claude: {
    host: "leaves out T3 Code's system prompt text and its t3-code MCP server; applies from the next turn",
    "global-instructions":
      "system prompt append after T3 Code's own text, sent fresh on each request (snapshot off), so a change applies from the next turn",
    skill:
      "flag settings skillOverrides (one skill) or the SDK skills allow list (all skills); calls are refused from the next turn, the skill list changes from the next new thread",
    agent: 'flag settings permissions.deny "Agent(name)" or "Agent" (all agents)',
    mcpServer: "flag settings deniedMcpServers, or strictMcpConfig for all servers",
  },
  codex: {
    "global-instructions": "turn additionalContext entry t3_code_instruction_profile",
    host: "leaves out T3 Code's additionalContext entries from the next turn, and its MCP servers when Codex starts or resumes the thread",
    skill:
      "config skills.config per skill, or skills.include_instructions=false for all; applies when Codex starts or resumes the thread",
    agent:
      "config agents.enabled=false for all agents; one agent cannot be switched off; applies when Codex starts or resumes the thread",
    mcpServer:
      "config mcp_servers.<name>.enabled=false, only for servers in config.toml; applies when Codex starts or resumes the thread",
  },
  acp: {
    "global-instructions": "block added to the first prompt beside T3 Code's instructions",
    host: "leaves out T3 Code's prompt notes and runtime info from the next turn, and its MCP server when the session next starts or loads; the Plan mode note stays in Plan mode",
    skill: undefined,
    agent: undefined,
    mcpServer: undefined,
  },
};

const PARTIAL: ReadonlySet<string> = new Set(["codex:agent", "codex:mcpServer"]);
const SUPPORT_KINDS: ReadonlyArray<SupportKind> = [
  "global-instructions",
  "skill",
  "agent",
  "mcpServer",
  "host",
];

const supportRow = (
  driver: InstructionProfileDriverSupport["driver"],
  family: keyof typeof SUPPORT_HOW | undefined,
): InstructionProfileDriverSupport => ({
  driver,
  kinds: SUPPORT_KINDS.map((kind) => {
    const how = family === undefined ? undefined : SUPPORT_HOW[family][kind];
    return how === undefined
      ? { kind, support: "no" as const, how: NO_SWITCH }
      : {
          kind,
          support: PARTIAL.has(`${family}:${kind}`) ? ("partial" as const) : ("yes" as const),
          how,
        };
  }),
});

/** Which switch kinds each driver honours, for the profile editor. */
export function instructionProfileSupportTable(): ReadonlyArray<InstructionProfileDriverSupport> {
  return [
    supportRow(ProviderDriverKind.make("claudeAgent"), "claude"),
    supportRow(ProviderDriverKind.make("codex"), "codex"),
    ...[...ACP_DRIVERS].map((driver) => supportRow(ProviderDriverKind.make(driver), "acp")),
    supportRow("*", undefined),
  ];
}
