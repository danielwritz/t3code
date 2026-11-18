import {
  PROVIDER_DISPLAY_NAMES,
  type AgentInputFidelity,
  type AgentInputLayer,
  type AgentInputLayerKind,
  type AgentInputOrigin,
  type AgentInputProfileUse,
  type AgentInputRequest,
  type AgentInputTextTarget,
  type AgentInputVerification,
  type InstructionProfileEffectKind,
  type InstructionProfileItemEffect,
  type ProviderDriverKind,
} from "@t3tools/contracts";

import { instructionProfileItemLabel } from "../settings/InstructionProfilesSettings.logic";

// Roughly the order the model reads them in.
const KIND_LABELS: Readonly<Record<AgentInputLayerKind, string>> = {
  "system-prompt": "System prompt",
  "host-instructions": "T3 Code instructions",
  profile: "Instruction profile",
  "instruction-file": "Instruction files",
  memory: "Memory",
  skills: "Skills",
  agents: "Agents",
  "mcp-instructions": "MCP instructions",
  tools: "Tools",
  environment: "Environment",
  "hook-output": "Hook output",
  "user-prompt": "User prompts",
  other: "Other",
};

const KIND_ORDER = Object.keys(KIND_LABELS) as ReadonlyArray<AgentInputLayerKind>;

export interface AgentInputLayerGroup {
  readonly kind: AgentInputLayerKind;
  readonly label: string;
  readonly chars: number;
  readonly layers: ReadonlyArray<AgentInputLayer>;
}

export function groupAgentInputLayers(
  layers: ReadonlyArray<AgentInputLayer>,
): ReadonlyArray<AgentInputLayerGroup> {
  return KIND_ORDER.flatMap((kind) => {
    const members = layers.filter((layer) => layer.kind === kind);
    if (members.length === 0) return [];
    return [
      {
        kind,
        label: KIND_LABELS[kind],
        chars: members.reduce((sum, layer) => sum + layer.chars, 0),
        layers: members,
      },
    ];
  });
}

const KIND_DESCRIPTIONS: Readonly<Record<AgentInputLayerKind, string>> = {
  "system-prompt": "The base instructions the agent's maker wrote.",
  "host-instructions": "Notes T3 Code adds so the agent can use T3 Code's features.",
  profile: "Your instructions from the instruction profile.",
  "instruction-file": "CLAUDE.md, AGENTS.md and similar files the agent loaded from your folders.",
  memory: "Notes the agent saved in earlier sessions.",
  skills: "The skills the agent can load when a task needs one.",
  agents: "The helper agents it can start.",
  "mcp-instructions": "Usage notes from connected MCP servers.",
  tools: "Definitions of the tools the agent can call.",
  environment: "Facts about your machine, folder, date and model.",
  "hook-output": "Text your hooks added.",
  "user-prompt": "Your messages in this thread.",
  other: "Other text the agent received.",
};

export function agentInputKindDescription(kind: AgentInputLayerKind): string {
  return KIND_DESCRIPTIONS[kind];
}

/** Who put a layer in front of the agent: the agent's maker, T3 Code, or the user. */
export type AgentInputOwner = "agent" | "t3" | "you";

const OWNERS: ReadonlyArray<AgentInputOwner> = ["agent", "t3", "you"];

export function agentInputOwner(origin: AgentInputOrigin): AgentInputOwner {
  if (origin === "harness") return "agent";
  if (origin === "t3") return "t3";
  return "you";
}

export interface AgentInputOwnerShare {
  readonly owner: AgentInputOwner;
  readonly chars: number;
  /** 0 to 1 of all layer characters. */
  readonly share: number;
}

/** Always the three owners, in a fixed order. */
export function agentInputOwnerShares(
  layers: ReadonlyArray<AgentInputLayer>,
): ReadonlyArray<AgentInputOwnerShare> {
  const total = layers.reduce((sum, layer) => sum + layer.chars, 0);
  return OWNERS.map((owner) => {
    const chars = layers
      .filter((layer) => agentInputOwner(layer.origin) === owner)
      .reduce((sum, layer) => sum + layer.chars, 0);
    return { owner, chars, share: total === 0 ? 0 : chars / total };
  });
}

/** True when the profile switched T3 Code's own instructions and tools off for this agent. */
export function agentInputProfileTurnsOffT3(profile: AgentInputProfileUse | undefined): boolean {
  if (profile === undefined) return false;
  if (profile.applied !== undefined) {
    return profile.applied.some(
      (effect) =>
        effect.kind === "host" && effect.requested === "off" && effect.result === "applied",
    );
  }
  return profile.effects.some((effect) => effect.toggle === "host" && effect.state === "applied");
}

const amount = (chars: number) => (chars === 0 ? "nothing" : formatAgentInputChars(chars));

export function agentInputSummarySentence(
  agentName: string,
  shares: ReadonlyArray<AgentInputOwnerShare>,
  profile?: AgentInputProfileUse,
): string {
  const chars = (owner: AgentInputOwner) =>
    shares.find((share) => share.owner === owner)?.chars ?? 0;
  const total = shares.reduce((sum, share) => sum + share.chars, 0);
  const t3 = chars("t3");
  const t3Off =
    t3 === 0 && profile !== undefined && agentInputProfileTurnsOffT3(profile)
      ? ` (switched off by profile "${profile.profileName}")`
      : "";
  return `${agentName} was given ${formatAgentInputChars(total)} characters: ${amount(chars("agent"))} from ${agentName} itself, ${amount(t3)} from T3 Code${t3Off} and ${amount(chars("you"))} from you.`;
}

interface ProfileEntry {
  readonly kind: InstructionProfileEffectKind;
  readonly requested?: InstructionProfileItemEffect["requested"];
  readonly result: "applied" | "not-supported" | "skipped" | "unchanged";
}

const profileEntries = (profile: AgentInputProfileUse): ReadonlyArray<ProfileEntry> =>
  profile.applied ??
  profile.effects.map((effect) => ({ kind: TOGGLE_KIND[effect.toggle], result: effect.state }));

/** Open the per-switch table when something the profile asked for did not happen. */
export function agentInputProfileNeedsDetails(profile: AgentInputProfileUse): boolean {
  return profileEntries(profile).some((entry) => entry.result === "not-supported");
}

/** What the profile did, in one or two plain sentences. */
export function agentInputProfileSentence(
  profile: AgentInputProfileUse,
  layers: ReadonlyArray<AgentInputLayer>,
): string {
  const entries = profileEntries(profile);
  const name = `Profile "${profile.profileName}"`;
  const instructionChars = layers
    .filter((layer) => layer.kind === "profile")
    .reduce((sum, layer) => sum + layer.chars, 0);
  const itemsOff = entries.filter(
    (entry) =>
      (entry.kind === "skill" || entry.kind === "agent" || entry.kind === "mcpServer") &&
      entry.requested !== "on" &&
      entry.result === "applied",
  ).length;
  const notApplied = entries.filter((entry) => entry.result === "not-supported").length;
  const did = [
    instructionChars > 0
      ? `added ${instructionChars.toLocaleString()} characters of your instructions`
      : null,
    itemsOff > 0 ? `turned off ${itemsOff} of your items` : null,
  ].filter((part) => part !== null);
  const sentences = agentInputProfileTurnsOffT3(profile)
    ? [
        `${name} is on: T3 Code added nothing to this thread.`,
        did.length === 0 ? null : `It also ${did.join(" and ")}.`,
      ]
    : [
        did.length === 0
          ? `${name} is on but changed nothing for this agent.`
          : `${name} ${did.join(" and ")}.`,
      ];
  if (notApplied > 0) {
    sentences.push(
      `${notApplied} ${notApplied === 1 ? "switch was" : "switches were"} not applied; see Details.`,
    );
  }
  return sentences.filter((sentence) => sentence !== null).join(" ");
}

const FIDELITY_LABELS: Readonly<Record<AgentInputFidelity, string>> = {
  exact: "Exact",
  "harness-record": "Agent's record",
  "t3-recorded": "Sent by T3 Code",
  none: "No record",
};

export function agentInputFidelityLabel(fidelity: AgentInputFidelity): string {
  return FIDELITY_LABELS[fidelity];
}

const FIDELITY_SENTENCES: Readonly<Record<AgentInputFidelity, string>> = {
  exact: "Rebuilt from the agent's own request record and checked against its digest",
  "harness-record": "From the agent's own session record",
  "t3-recorded": "Only what T3 Code sent; this agent keeps no readable record",
  none: "Nothing recorded for this thread yet",
};

export function agentInputFidelitySentence(fidelity: AgentInputFidelity): string {
  return FIDELITY_SENTENCES[fidelity];
}

export function formatAgentInputChars(chars: number): string {
  if (chars < 1_000) return String(chars);
  if (chars < 999_950) return `${(chars / 1_000).toFixed(1)}k`;
  return `${(chars / 1_000_000).toFixed(1)}M`;
}

export function formatAgentInputShare(share: number): string {
  if (share > 0 && share < 0.005) return "<1%";
  return `${Math.round(share * 100)}%`;
}

export type AgentInputLayerWhen =
  | { readonly type: "request"; readonly label: string }
  | { readonly type: "time"; readonly at: string };

export function agentInputLayerWhen(layer: AgentInputLayer): AgentInputLayerWhen | null {
  if (layer.requestIndex !== undefined) {
    return { type: "request", label: agentInputRequestLabel(layer.requestIndex) };
  }
  if (layer.at !== undefined) return { type: "time", at: layer.at };
  return null;
}

/** Request indexes count from 0 on the wire and from 1 on screen. */
export function agentInputRequestLabel(index: number): string {
  return `Request ${index + 1}`;
}

const ORIGIN_LABELS: Readonly<Record<AgentInputOrigin, string>> = {
  harness: "Agent",
  t3: "T3 Code",
  "user-file": "Your file",
  "mcp-server": "MCP server",
  hook: "Hook",
  profile: "Profile",
  user: "You",
};

export function agentInputOriginLabel(origin: AgentInputOrigin): string {
  return ORIGIN_LABELS[origin];
}

export function agentInputDriverLabel(driver: ProviderDriverKind): string {
  return PROVIDER_DISPLAY_NAMES[driver] ?? driver;
}

const SECTION_TITLE = /^Section: ([\w-]+)$/;
const WORD_CASE: Readonly<Record<string, string>> = { t3: "T3", code: "Code", mcp: "MCP" };

/** A readable title; a raw section tag such as `multi_agent_role` reads "Multi agent role". */
export function agentInputLayerTitle(layer: AgentInputLayer): string {
  const match = SECTION_TITLE.exec(layer.title);
  if (match === null) return layer.title || layer.preview || layer.id;
  const tag = match[1]!;
  const words = tag
    .split(/[_-]+/)
    .filter((word) => word.length > 0)
    .map((word, index, all) => {
      if (/^\d+$/.test(word)) return String(Number(word));
      if (word === "code" && all[index - 1] !== "t3") return word;
      return WORD_CASE[word] ?? word;
    });
  const title = words.join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** The selection while the trace still has it; a refresh can drop a layer or a request. */
export function agentInputTargetInTrace(
  trace: {
    readonly layers: ReadonlyArray<AgentInputLayer>;
    readonly requests: ReadonlyArray<AgentInputRequest>;
  } | null,
  target: AgentInputTextTarget | null,
): AgentInputTextTarget | null {
  if (target === null || trace === null) return target;
  const present =
    target.type === "layer"
      ? trace.layers.some((layer) => layer.id === target.layerId)
      : trace.requests.some((request) => request.index === target.index);
  return present ? target : null;
}

/** Request cards show the check of a part read since the trace loaded. */
export function withRequestChecks(
  requests: ReadonlyArray<AgentInputRequest>,
  checks: Readonly<Record<number, AgentInputVerification>>,
): ReadonlyArray<AgentInputRequest> {
  if (Object.keys(checks).length === 0) return requests;
  return requests.map((request) => {
    const check = checks[request.index];
    return check === undefined || check === request.verification
      ? request
      : { ...request, verification: check };
  });
}

export function agentInputTextTargetKey(target: AgentInputTextTarget): string {
  return target.type === "layer"
    ? `layer:${target.layerId}`
    : `request:${target.index}:${target.part}`;
}

interface AgentInputProfileEffectRow {
  readonly key: string;
  readonly item: string;
  /** Absent for servers that recorded only the short effects. */
  readonly asked?: string;
  readonly result: string;
  readonly tone: "success" | "warning" | "secondary";
  /** The switch used; absent when none was. */
  readonly how?: string;
  readonly reason?: string;
}

// The planner writes "none" when no switch was used.
const howOf = (how: string) => (how === "none" || how.length === 0 ? {} : { how });

const ASKED_LABEL: Readonly<Record<InstructionProfileItemEffect["requested"], string>> = {
  on: "Turn on",
  off: "Turn off",
  add: "Add",
};

const RESULT_LABEL = {
  applied: { label: "Applied", tone: "success" },
  "not-supported": { label: "Not supported", tone: "warning" },
  skipped: { label: "Skipped", tone: "secondary" },
  unchanged: { label: "Unchanged", tone: "secondary" },
} as const;

const TOGGLE_KIND: Readonly<
  Record<AgentInputProfileUse["effects"][number]["toggle"], InstructionProfileEffectKind>
> = {
  globalInstructions: "global-instructions",
  skill: "skill",
  agent: "agent",
  mcpServer: "mcpServer",
  host: "host",
};

/** One row per profile entry: what was asked, what happened, the switch used and why not. */
export function agentInputProfileEffectRows(
  profile: AgentInputProfileUse,
): ReadonlyArray<AgentInputProfileEffectRow> {
  if (profile.applied !== undefined) {
    return profile.applied.map((effect) => ({
      key: `${effect.kind}:${effect.name ?? ""}`,
      item: instructionProfileItemLabel(effect.kind, effect.name),
      asked: ASKED_LABEL[effect.requested],
      result: RESULT_LABEL[effect.result].label,
      tone: RESULT_LABEL[effect.result].tone,
      ...howOf(effect.how),
      ...(effect.reason === undefined ? {} : { reason: effect.reason }),
    }));
  }
  return profile.effects.map((effect) => {
    const kind = TOGGLE_KIND[effect.toggle];
    return {
      key: `${kind}:${effect.name ?? ""}`,
      item: instructionProfileItemLabel(kind, effect.name),
      result: RESULT_LABEL[effect.state].label,
      tone: RESULT_LABEL[effect.state].tone,
      ...howOf(effect.detail),
    };
  });
}
