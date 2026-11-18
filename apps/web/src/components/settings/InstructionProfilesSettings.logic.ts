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
  /** T3 Code's own instructions and tools; saved as one host item when off. */
  readonly t3: boolean;
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
  host: {
    one: "T3 Code's own instructions and tools",
    all: "T3 Code's own instructions and tools",
  },
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
  return {
    id: undefined,
    name: "",
    description: "",
    globalInstructions: "",
    t3: true,
    items: [],
  };
}

const t3SwitchOf = (items: ReadonlyArray<{ readonly kind: string; readonly enabled: boolean }>) =>
  !items.some((item) => item.kind === "host" && !item.enabled);

const T3_OFF_ITEM = { kind: "host", name: INSTRUCTION_PROFILE_ALL_ITEMS, enabled: false } as const;

export function draftFromProfile(profile: InstructionProfile): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    globalInstructions: profile.globalInstructions,
    t3: t3SwitchOf(profile.items),
    items: profile.items
      .filter((item) => item.kind !== "host")
      .map((item) => ({ ...item, key: newProfileDraftItemKey() })),
  };
}

type ProfileDraftSaveResult =
  | { readonly ok: true; readonly input: SaveInstructionProfileInput }
  | { readonly ok: false; readonly error: string };

export function profileDraftSaveInput(
  draft: ProfileDraft,
  others: ReadonlyArray<Pick<InstructionProfile, "id" | "name">> = [],
): ProfileDraftSaveResult {
  const name = draft.name.trim();
  if (name.length === 0) return { ok: false, error: "Give the profile a name." };
  const taken = others.find(
    (other) => other.id !== draft.id && other.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (taken !== undefined) {
    return { ok: false, error: `A profile named ${taken.name} already exists.` };
  }
  const items = draft.items
    .map((item) => ({ kind: item.kind, name: item.name.trim(), enabled: item.enabled }))
    .filter((item) => item.name.length > 0);
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.kind}\0${item.name}`;
    if (seen.has(key)) {
      return {
        ok: false,
        error: `Two switches are for ${instructionProfileItemLabel(item.kind, item.name)}. Remove one.`,
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
      items: draft.t3 ? items : [...items, T3_OFF_ITEM],
    },
  };
}

/** Compares with the saved profile; a new empty draft counts as unchanged. */
export function isProfileDraftChanged(
  draft: ProfileDraft,
  saved: InstructionProfile | undefined,
): boolean {
  const base = saved === undefined ? emptyProfileDraft() : draftFromProfile(saved);
  const strip = (items: ReadonlyArray<{ kind: string; name: string; enabled: boolean }>) =>
    items.map((item) => [item.kind, item.name, item.enabled]);
  return (
    draft.name !== base.name ||
    draft.description !== base.description ||
    draft.globalInstructions !== base.globalInstructions ||
    draft.t3 !== base.t3 ||
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

/** What agents under a profile get, in the words the list and the editor share. */
export function instructionProfileSummary(
  profile: Pick<InstructionProfile, "globalInstructions" | "items">,
): string {
  const instructions = profile.globalInstructions.trim().length;
  const off = profile.items.filter((item) => item.kind !== "host" && !item.enabled);
  const allOff = off
    .filter((item) => item.name === INSTRUCTION_PROFILE_ALL_ITEMS)
    .map((item) => `${KIND_NOUN[item.kind].all.toLowerCase().replace("mcp", "MCP")} off`);
  const named = off.length - allOff.length;
  const items = [...allOff, named > 0 ? `${named} of your items off` : null]
    .filter((part) => part !== null)
    .join(", ");
  return [
    instructions === 0
      ? "No instructions of your own"
      : `Your instructions (${instructions.toLocaleString()} characters)`,
    t3SwitchOf(profile.items) ? "T3 Code features" : "Interface only",
    items.length === 0 ? "all your items on" : items,
  ].join(" · ");
}

// The server's `how` sentence says when a switch takes effect; the table shows only that.
const SUPPORT_TIMING: ReadonlyArray<readonly [RegExp, string]> = [
  [/next turn/i, "from the next turn"],
  [/next new thread/i, "from the next new thread"],
  [/starts or (resumes|loads)|session (next )?starts/i, "when the thread starts or resumes"],
];

/** A support cell in plain words: "Works from the next turn", "Not supported". */
export function instructionProfileSupportResult(cell: SupportCell): string {
  if (cell.support === "no") return "Not supported";
  const timing = SUPPORT_TIMING.find(([pattern]) => pattern.test(cell.how))?.[1];
  if (cell.support === "partial")
    return timing === undefined ? "Partly works" : `Partly works, ${timing}`;
  return timing === undefined ? "Works" : `Works ${timing}`;
}

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

const SOURCE_LABEL: Readonly<
  Record<Exclude<InstructionProfileSource, "none">, { line: string; spoken: string }>
> = {
  thread: { line: "For this thread", spoken: "for this thread" },
  project: { line: "From the project", spoken: "from the project" },
  default: { line: "The default", spoken: "the default" },
};

/** The thread row: the profile name on one line, where it comes from on the next. */
export function threadProfileChoice(value: ThreadInstructionProfile): {
  readonly name: string;
  readonly source: string;
  readonly label: string;
  /** The profile switches T3 Code's own instructions and tools off. */
  readonly interfaceOnly: boolean;
} {
  const profile = value.profile;
  if (profile === undefined || value.source === "none") {
    return {
      name: "No profile",
      source: "Instruction profile",
      label: "Instruction profile: none",
      interfaceOnly: false,
    };
  }
  const source = SOURCE_LABEL[value.source];
  return {
    name: profile.name,
    source: source.line,
    label: `Instruction profile: ${profile.name}, ${source.spoken}`,
    interfaceOnly: !t3SwitchOf(profile.items),
  };
}
