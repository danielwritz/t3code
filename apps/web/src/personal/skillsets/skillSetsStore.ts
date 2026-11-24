// Prototype state for skill sets: which sets are registered, which one a thread runs on, and
// which of the three picker placements is shown. In the real feature the registry lives in the
// server settings and the active set on the thread; here it is client state over a fixture.
import { useSyncExternalStore } from "react";

export type SkillSetVariant = "off" | "tabs" | "rail" | "chip" | "both";

export type SkillSetLogo =
  | { readonly kind: "image"; readonly src: string }
  | { readonly kind: "monogram"; readonly text: string; readonly color: string };

export interface SkillSetSkill {
  readonly name: string;
  readonly description: string;
  readonly manualOnly: boolean;
  readonly listingTokens: number;
  readonly enabled: boolean;
  readonly installedFor?: ReadonlyArray<string>;
}

export interface SkillSet {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly logo: SkillSetLogo;
  readonly repo: {
    readonly state: "synced" | "local";
    readonly label: string;
    readonly path: string;
    readonly upstream?: string;
    readonly branch?: string;
    readonly commit?: string;
    readonly commitDate?: string;
    readonly version?: string;
    readonly proposed?: string;
  };
  readonly isDefault: boolean;
  readonly skills: ReadonlyArray<SkillSetSkill>;
  readonly listingTokens: number;
}

/** The data the prototype and its screenshots run on. */
interface SetupFixture {
  readonly skillSets: ReadonlyArray<SkillSet>;
  readonly thread: {
    readonly title: string;
    readonly otherTitles: ReadonlyArray<string>;
    readonly turns: ReadonlyArray<ReadonlyArray<string>>;
  };
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly projectIcon?: unknown;
  }>;
  readonly providers: ReadonlyArray<unknown>;
  readonly providerInstances: unknown;
  readonly clientSettings: unknown;
}

// setup.fixture.json is one user's real setup and stays out of git. A clean checkout has only
// the neutral example, so the glob finds whichever files exist and the private one wins.
const fixtures = import.meta.glob<SetupFixture>("./setup.fixture*.json", {
  eager: true,
  import: "default",
});
const PRIVATE_FIXTURE = fixtures["./setup.fixture.json"];

export const hasPrivateSetup = PRIVATE_FIXTURE !== undefined;
export const setup: SetupFixture = PRIVATE_FIXTURE ?? fixtures["./setup.fixture.example.json"]!;

const SKILL_SETS = setup.skillSets;

interface State {
  readonly variant: SkillSetVariant;
  readonly activeId: string;
}

let state: State = { variant: "off", activeId: SKILL_SETS.find((set) => set.isDefault)?.id ?? "" };
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function setSkillSetVariant(variant: SkillSetVariant) {
  state = { ...state, variant };
  emit();
}

export function setActiveSkillSet(activeId: string) {
  state = { ...state, activeId };
  emit();
}

export function useSkillSets() {
  const current = useSyncExternalStore(subscribe, () => state);
  return {
    variant: current.variant,
    sets: SKILL_SETS,
    active: SKILL_SETS.find((set) => set.id === current.activeId) ?? SKILL_SETS[0]!,
  };
}
