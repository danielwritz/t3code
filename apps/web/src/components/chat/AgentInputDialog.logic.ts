import type {
  AgentInputFidelity,
  AgentInputLayer,
  AgentInputLayerKind,
  AgentInputTextTarget,
} from "@t3tools/contracts";

// Roughly the order the model reads them in.
const KIND_LABELS: Readonly<Record<AgentInputLayerKind, string>> = {
  "system-prompt": "System prompt",
  "host-instructions": "T3 instructions",
  profile: "Profile",
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

export interface AgentInputSizeSegment {
  readonly kind: AgentInputLayerKind;
  readonly label: string;
  readonly chars: number;
  /** 0 to 1 of all layer characters. */
  readonly share: number;
}

export function agentInputSizeSegments(
  layers: ReadonlyArray<AgentInputLayer>,
): ReadonlyArray<AgentInputSizeSegment> {
  const groups = groupAgentInputLayers(layers).filter((group) => group.chars > 0);
  const total = groups.reduce((sum, group) => sum + group.chars, 0);
  if (total === 0) return [];
  return groups
    .map((group) => ({
      kind: group.kind,
      label: group.label,
      chars: group.chars,
      share: group.chars / total,
    }))
    .toSorted((left, right) => right.chars - left.chars);
}

const FIDELITY_SENTENCES: Readonly<Record<AgentInputFidelity, string>> = {
  exact: "Exact: rebuilt from the agent's own request record and checked against its digest",
  "harness-record": "From the agent's own session record",
  "t3-recorded": "Only what T3 sent; this agent keeps no readable record",
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

export function agentInputTextTargetKey(target: AgentInputTextTarget): string {
  return target.type === "layer"
    ? `layer:${target.layerId}`
    : `request:${target.index}:${target.part}`;
}
