import { create } from "zustand";

/** The three drivers a profile applies to, in the order the profile page shows them. */
export const PROFILE_PROVIDERS = [
  { driver: "claudeAgent", name: "Claude", instructionsFile: "CLAUDE.md" },
  { driver: "codex", name: "Codex", instructionsFile: "AGENTS.md" },
  { driver: "antigravity", name: "Antigravity", instructionsFile: "GEMINI.md" },
] as const;
export type ProfileProvider = (typeof PROFILE_PROVIDERS)[number]["driver"];

export interface ProfileFile {
  readonly file: string;
  readonly lines: number;
  readonly preview: string;
}
export interface ProfileHook {
  readonly event: string;
  readonly matcher?: string;
  readonly command: string;
}
export interface ProfileMcpServer {
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly target: string;
}

/**
 * The profile folder's parts besides `skills/`: `instructions.md` (or a provider's own file),
 * `plugins.json`, `hooks/<provider>.json` and `mcp.json`. Every part is optional.
 */
export interface ProfileParts {
  readonly instructions: Partial<Record<ProfileProvider | "shared", ProfileFile>>;
  readonly plugins: Partial<Record<ProfileProvider, readonly string[]>>;
  readonly hooks: Partial<Record<ProfileProvider, readonly ProfileHook[]>>;
  readonly mcp: readonly ProfileMcpServer[];
  readonly ignoreProjectInstructions: boolean;
}

const NO_PARTS: ProfileParts = {
  instructions: {},
  plugins: {},
  hooks: {},
  mcp: [],
  ignoreProjectInstructions: false,
};

export const instructionsFor = (parts: ProfileParts, provider: ProfileProvider) =>
  parts.instructions[provider] ?? parts.instructions.shared;

export const isStockProfile = (parts: ProfileParts, skillCount: number) =>
  skillCount === 0 &&
  Object.keys(parts.instructions).length === 0 &&
  Object.values(parts.plugins).every((ids) => ids.length === 0) &&
  Object.values(parts.hooks).every((hooks) => hooks.length === 0) &&
  parts.mcp.length === 0;

// Prototype state: the server does not serve profile parts yet, so every profile reads as
// skills-only until it does. The switches live in this tab only.
interface ProfileState {
  readonly parts: Readonly<Record<string, ProfileParts>>;
  readonly ignoreByProfile: Readonly<Record<string, boolean>>;
  readonly ignoreByThread: Readonly<Record<string, boolean>>;
}
const useProfileState = create<ProfileState>(() => ({
  parts: {},
  ignoreByProfile: {},
  ignoreByThread: {},
}));

export function __setProfilePartsForTests(parts: Readonly<Record<string, ProfileParts>>) {
  useProfileState.setState({ parts, ignoreByProfile: {}, ignoreByThread: {} });
}

export function useProfileParts(profileId: string | undefined) {
  return useProfileState((state) => (profileId && state.parts[profileId]) || NO_PARTS);
}

export function useProfileIgnoresProject(profileId: string | undefined) {
  const parts = useProfileParts(profileId);
  const own = useProfileState((state) =>
    profileId ? state.ignoreByProfile[profileId] : undefined,
  );
  return own ?? parts.ignoreProjectInstructions;
}

export function setProfileIgnoresProject(profileId: string, ignore: boolean) {
  useProfileState.setState((state) => ({
    ignoreByProfile: { ...state.ignoreByProfile, [profileId]: ignore },
  }));
}

/** A thread's own choice, or the profile's when the thread has none. */
export function useThreadIgnoresProject(profileId: string | undefined, threadKey: string | null) {
  const fromProfile = useProfileIgnoresProject(profileId);
  const own = useProfileState((state) => (threadKey ? state.ignoreByThread[threadKey] : undefined));
  return { ignore: own ?? fromProfile, overridden: own !== undefined && own !== fromProfile };
}

export function setThreadIgnoresProject(threadKey: string, ignore: boolean) {
  useProfileState.setState((state) => ({
    ignoreByThread: { ...state.ignoreByThread, [threadKey]: ignore },
  }));
}
