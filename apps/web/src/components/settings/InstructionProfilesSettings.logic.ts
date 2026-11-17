import {
  INSTRUCTION_PROFILE_ALL_ITEMS,
  PROVIDER_DISPLAY_NAMES,
  type InstructionProfile,
  type InstructionProfileDriverSupport,
  type InstructionProfileEffectKind,
  type InstructionProfileItemKind,
  type InstructionProfileSource,
  type InstructionProfileSupportLevel,
  type SaveInstructionProfileInput,
  type ThreadInstructionProfile,
} from "@t3tools/contracts";

interface ProfileDraftItem {
  /** Stable row key while editing; not saved. */
  readonly key: string;
  readonly kind: InstructionProfileItemKind;
  readonly name: string;
  readonly enabled: boolean;
}

export interface ProfileDraft {
  readonly id: string | undefined;
  readonly name: string;
  readonly description: string;
  readonly globalInstructions: string;
  readonly items: ReadonlyArray<ProfileDraftItem>;
}

export const INSTRUCTION_PROFILE_ITEM_KINDS: ReadonlyArray<InstructionProfileItemKind> = [
  "skill",
  "agent",
  "mcpServer",
];

const KIND_NOUN: Readonly<Record<InstructionProfileEffectKind, { one: string; all: string }>> = {
  "global-instructions": { one: "Global instructions", all: "Global instructions" },
  skill: { one: "Skill", all: "All skills" },
  agent: { one: "Agent", all: "All agents" },
  mcpServer: { one: "MCP server", all: "All MCP servers" },
};

export function instructionProfileKindLabel(kind: InstructionProfileEffectKind): string {
  return KIND_NOUN[kind].one;
}

export function instructionProfileItemLabel(
  kind: InstructionProfileEffectKind,
  name: string | undefined,
): string {
  if (kind === "global-instructions") return KIND_NOUN[kind].one;
  if (name === undefined || name === INSTRUCTION_PROFILE_ALL_ITEMS) return KIND_NOUN[kind].all;
  return `${KIND_NOUN[kind].one} ${name}`;
}

let nextDraftKey = 0;
export function newProfileDraftItemKey(): string {
  nextDraftKey += 1;
  return `item-${nextDraftKey}`;
}

export function emptyProfileDraft(): ProfileDraft {
  return { id: undefined, name: "", description: "", globalInstructions: "", items: [] };
}

export function draftFromProfile(profile: InstructionProfile): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    globalInstructions: profile.globalInstructions,
    items: profile.items.map((item) => ({ ...item, key: newProfileDraftItemKey() })),
  };
}

type ProfileDraftSaveResult =
  | { readonly ok: true; readonly input: SaveInstructionProfileInput }
  | { readonly ok: false; readonly error: string };

export function profileDraftSaveInput(draft: ProfileDraft): ProfileDraftSaveResult {
  const name = draft.name.trim();
  if (name.length === 0) return { ok: false, error: "Give the profile a name." };
  const items = draft.items
    .map((item) => ({ kind: item.kind, name: item.name.trim(), enabled: item.enabled }))
    .filter((item) => item.name.length > 0);
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.kind}\0${item.name}`;
    if (seen.has(key)) {
      return {
        ok: false,
        error: `${instructionProfileItemLabel(item.kind, item.name)} is listed twice.`,
      };
    }
    seen.add(key);
  }
  return {
    ok: true,
    input: {
      ...(draft.id === undefined ? {} : { id: draft.id }),
      name,
      description: draft.description,
      globalInstructions: draft.globalInstructions,
      items,
    },
  };
}

/** Compares with the saved profile; a new empty draft counts as unchanged. */
export function isProfileDraftChanged(
  draft: ProfileDraft,
  saved: InstructionProfile | undefined,
): boolean {
  const base = saved === undefined ? emptyProfileDraft() : saved;
  const strip = (items: ReadonlyArray<{ kind: string; name: string; enabled: boolean }>) =>
    items.map((item) => [item.kind, item.name, item.enabled]);
  return (
    draft.name !== base.name ||
    draft.description !== base.description ||
    draft.globalInstructions !== base.globalInstructions ||
    JSON.stringify(strip(draft.items)) !== JSON.stringify(strip(base.items))
  );
}

interface SupportCell {
  readonly kind: InstructionProfileEffectKind;
  readonly support: InstructionProfileSupportLevel;
  readonly how: string;
}

interface SupportRow {
  readonly key: string;
  readonly label: string;
  readonly cells: ReadonlyArray<SupportCell>;
}

const driverLabel = (driver: InstructionProfileDriverSupport["driver"]) =>
  driver === "*" ? "Every other agent" : (PROVIDER_DISPLAY_NAMES[driver] ?? driver);

/** One row per set of drivers that share the same switches, in the server's order. */
export function instructionProfileSupportRows(
  drivers: ReadonlyArray<InstructionProfileDriverSupport>,
): ReadonlyArray<SupportRow> {
  const rows: Array<{
    key: string;
    drivers: Array<InstructionProfileDriverSupport["driver"]>;
    cells: ReadonlyArray<SupportCell>;
  }> = [];
  for (const entry of drivers) {
    const key = JSON.stringify(entry.kinds);
    const match = entry.driver === "*" ? undefined : rows.find((row) => row.key === key);
    if (match !== undefined && !match.drivers.includes("*")) {
      match.drivers.push(entry.driver);
      continue;
    }
    rows.push({ key, drivers: [entry.driver], cells: entry.kinds });
  }
  return rows.map((row) => ({
    key: row.drivers.join(","),
    label: row.drivers.map(driverLabel).join(", "),
    cells: row.cells,
  }));
}

const SOURCE_LABEL: Readonly<Record<InstructionProfileSource, string>> = {
  thread: "This thread",
  project: "Project",
  default: "Default",
  none: "None",
};

export function threadProfileChoice(value: ThreadInstructionProfile): {
  readonly name: string;
  readonly source: string;
  readonly label: string;
} {
  const profile = value.profile;
  if (profile === undefined)
    return { name: "None", source: SOURCE_LABEL.none, label: "Profile: None" };
  const source = SOURCE_LABEL[value.source];
  return { name: profile.name, source, label: `Profile: ${profile.name} · ${source}` };
}
