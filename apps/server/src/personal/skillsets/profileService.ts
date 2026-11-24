// @effect-diagnostics nodeBuiltinImport:off -- Writes only T3-owned profile folders under the state dir.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type {
  AgentProfileThreadOptions,
  AgentProfileView,
  SkillSetConfig,
  SkillSetStatus,
} from "@t3tools/contracts";
import type { MachineInventory } from "./inventory.ts";
import {
  PROFILE_REFERENCES_FILE,
  profileItems,
  profileView,
  readProfileFolder,
} from "./profile.ts";
import type { ThreadProfileOptions } from "./profileState.ts";
import { writeSideFile } from "./state.ts";
import { scanSkills, skillSetCheckoutPath } from "./sync.ts";

interface ProfileServiceDependencies {
  readonly stateDir: string;
  readonly skillSets: () => Promise<Readonly<Record<string, SkillSetConfig>>>;
  /** Replaces (or adds) one profile's config in the skill-set side file. */
  readonly saveSkillSet: (id: string, config: SkillSetConfig) => Promise<void>;
  readonly statuses: () => readonly SkillSetStatus[];
  readonly syncNow: (id: string) => Promise<void>;
  readonly inventory: () => Promise<MachineInventory>;
  readonly threadOptions: ThreadProfileOptions;
}

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function makeAgentProfileService(deps: ProfileServiceDependencies) {
  const view = async (id: string, config: SkillSetConfig): Promise<AgentProfileView> => {
    const root = skillSetCheckoutPath(deps.stateDir, id, config);
    const folder = await readProfileFolder(root);
    const status = deps.statuses().find((entry) => entry.id === id);
    const skills = status?.skills ?? (await scanSkills(root).catch(() => []));
    const { items, errors } = profileItems({
      folder,
      skills,
      overlay: config,
      inventory: await deps.inventory(),
    });
    return profileView({
      id,
      name: config.name,
      root,
      ignoreProjectInstructions: config.ignoreProjectInstructions ?? false,
      items,
      errors,
    });
  };
  const config = async (id: string) => {
    const found = (await deps.skillSets())[id];
    if (!found) throw new Error(`No agent profile ${id}`);
    return found;
  };
  const save = async (id: string, next: SkillSetConfig) => {
    await deps.saveSkillSet(id, next);
    return view(id, next);
  };
  return {
    list: async (): Promise<readonly AgentProfileView[]> =>
      Promise.all(Object.entries(await deps.skillSets()).map(([id, set]) => view(id, set))),
    setItemEnabled: async (profileId: string, itemId: string, enabled: boolean) => {
      const current = await config(profileId);
      const known = (await view(profileId, current)).items.some((item) => item.id === itemId);
      if (!known) throw new Error(`Agent profile ${profileId} has no item ${itemId}`);
      const toggle = (list: readonly string[], value: string) =>
        enabled ? list.filter((entry) => entry !== value) : [...new Set([...list, value])];
      // Skills keep using `disabledSkills`, which the skill-set screen already writes.
      // Machine-policy hooks start off, so switching one on is recorded in `enabledItems`.
      const next = itemId.startsWith("policy:")
        ? {
            ...current,
            enabledItems: enabled
              ? [...new Set([...(current.enabledItems ?? []), itemId])]
              : (current.enabledItems ?? []).filter((entry) => entry !== itemId),
            disabledItems: toggle(current.disabledItems ?? [], itemId),
          }
        : itemId.startsWith("skill:")
          ? {
              ...current,
              disabledSkills: toggle(current.disabledSkills, itemId.slice("skill:".length)),
              disabledItems: (current.disabledItems ?? []).filter((entry) => entry !== itemId),
            }
          : { ...current, disabledItems: toggle(current.disabledItems ?? [], itemId) };
      return save(profileId, next);
    },
    setIgnoreProject: async (profileId: string, ignore: boolean) =>
      save(profileId, { ...(await config(profileId)), ignoreProjectInstructions: ignore }),
    threadOptions: async (threadId: string): Promise<AgentProfileThreadOptions> => ({
      threadId,
      ignoreProjectInstructions: await deps.threadOptions.ignoreProject(threadId),
    }),
    setThreadIgnoreProject: async (
      threadId: string,
      ignore: boolean | null,
    ): Promise<AgentProfileThreadOptions> => {
      await deps.threadOptions.setIgnoreProject(threadId, ignore);
      return { threadId, ignoreProjectInstructions: ignore };
    },
    /** A local profile folder holding only `refs.json`; it follows the real files (decision 13). */
    createFromReferences: async (id: string, name: string, references: readonly string[]) => {
      if (!PROFILE_ID.test(id)) throw new Error(`Invalid agent profile id ${id}`);
      if ((await deps.skillSets())[id]) throw new Error(`Agent profile ${id} exists`);
      const inventory = (await deps.inventory()).providers.flatMap((entry) => entry.items);
      for (const reference of references) {
        const found = inventory.find((item) => item.id === reference);
        if (!found) throw new Error(`Reference ${reference} was not found`);
      }
      const root = NodePath.join(deps.stateDir, "skill-sets", "profiles", id);
      if (await NodeFSP.lstat(root).catch(() => undefined))
        throw new Error(`Profile folder for ${id} already exists`);
      await writeSideFile(
        NodePath.join(root, PROFILE_REFERENCES_FILE),
        [...new Set(references)].map((ref) => ({ ref })),
      );
      const created: SkillSetConfig = {
        name,
        source: { kind: "local", path: root },
        enabled: true,
        autoSync: false,
        disabledSkills: [],
      };
      await deps.saveSkillSet(id, created);
      await deps.syncNow(id);
      return view(id, created);
    },
  };
}
export type AgentProfileService = ReturnType<typeof makeAgentProfileService>;
