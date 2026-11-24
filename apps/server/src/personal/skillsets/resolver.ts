// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Pure Node filesystem/process modules are tested on native links and injected time.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  agentProfileProviderForDriver,
  type ServerProviderSkill,
  type SkillSetConfig,
  type SkillSetStatus,
  type SkillSetSkill,
} from "@t3tools/contracts";
import { buildSkillSetHome, type OwnedChange, type OwnedEntries } from "./home.ts";
import type { MachineInventory } from "./inventory.ts";
import {
  profileItems,
  readProfileFolder,
  resolveAgentProfile,
  type ResolvedAgentProfile,
} from "./profile.ts";
import { skillSetCheckoutPath } from "./sync.ts";

export interface SkillSetThread {
  readonly skillSetId?: string | null | undefined;
  /** The T3 thread, for its own "ignore project instructions" choice. */
  readonly threadId?: string | undefined;
  readonly id?: string | undefined;
}
export interface SkillSetInstance {
  readonly instanceId: string;
  readonly realHome: string;
  readonly skillsEntry: string;
  readonly privateEntries?: readonly string[];
  /**
   * Top-level entries the provider builds from the profile instead of linking (lead decisions 5, 8-10).
   * Must depend only on the profile: threads with the same profile share one built home.
   */
  readonly owned?: (profile: ResolvedAgentProfile) => OwnedEntries | Promise<OwnedEntries>;
}
export interface ResolvedSkillSetHome {
  readonly homePath: string;
  readonly skillsDir: string;
  readonly skills: readonly SkillSetSkill[];
  /** Undefined for drivers that profiles do not support. */
  readonly profile?: ResolvedAgentProfile | undefined;
  readonly ownedChanges?: readonly OwnedChange[];
}
interface ResolverDependencies {
  readonly stateDir: string;
  readonly settings: {
    readonly skillSetsEnabled: boolean;
    readonly defaultSkillSetId: string | null;
    readonly skillSets: Readonly<Record<string, SkillSetConfig>>;
  };
  readonly statuses: readonly SkillSetStatus[];
  readonly warn: (message: string) => void;
  /** The real setup: references and machine-policy hooks. */
  readonly inventory?: () => Promise<MachineInventory>;
  readonly threadIgnoresProject?: (threadId: string) => Promise<boolean | null>;
}

function selectedSet(deps: ResolverDependencies, thread: SkillSetThread) {
  if (!deps.settings.skillSetsEnabled) return;
  const id = thread.skillSetId ?? deps.settings.defaultSkillSetId;
  if (!id) return;
  const set = deps.settings.skillSets[id];
  const status = deps.statuses.find((value) => value.id === id);
  if (
    !set?.enabled ||
    !status ||
    ((status.state === "syncing" || status.state === "error") && status.ready !== true)
  ) {
    deps.warn(`Skill set ${id} is missing, disabled or not ready; using provider home`);
    return;
  }
  return { id, set, status };
}

async function profileFor(
  deps: ResolverDependencies,
  driver: string,
  thread: SkillSetThread,
  selected: NonNullable<ReturnType<typeof selectedSet>>,
): Promise<ResolvedAgentProfile | undefined> {
  const provider = agentProfileProviderForDriver(driver);
  if (!provider) return;
  const root = skillSetCheckoutPath(deps.stateDir, selected.id, selected.set);
  const folder = await readProfileFolder(root);
  const { items, errors } = profileItems({
    folder,
    skills: selected.status.skills,
    overlay: selected.set,
    // Machine-policy hooks are part of every profile, so the inventory is always read.
    inventory: await deps.inventory?.(),
  });
  for (const error of errors) deps.warn(`Agent profile ${selected.id}: ${error}`);
  const threadId = thread.threadId ?? thread.id;
  const threadChoice = threadId ? await deps.threadIgnoresProject?.(threadId) : null;
  return resolveAgentProfile({
    profileId: selected.id,
    provider,
    root,
    items,
    ignoreProjectInstructions: threadChoice ?? selected.set.ignoreProjectInstructions ?? false,
  });
}

/** The thread's profile for one provider, without building a home. */
export async function resolveProfile(
  deps: ResolverDependencies,
  driver: string,
  thread: SkillSetThread,
): Promise<ResolvedAgentProfile | undefined> {
  const selected = selectedSet(deps, thread);
  if (!selected) return;
  try {
    return await profileFor(deps, driver, thread, selected);
  } catch (error) {
    deps.warn(`Could not read agent profile ${selected.id}; using provider home: ${String(error)}`);
    return;
  }
}

const builds = new Map<string, ReturnType<typeof buildSkillSetHome>>();
export async function resolveHome(
  deps: ResolverDependencies,
  driver: string,
  instance: SkillSetInstance,
  thread: SkillSetThread,
): Promise<ResolvedSkillSetHome | undefined> {
  const selected = selectedSet(deps, thread);
  if (!selected) return;
  const { id, set, status } = selected;
  const digest = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([driver, instance.instanceId, instance.realHome, id]))
    .digest("hex")
    .slice(0, 24);
  const outputPath = NodePath.join(deps.stateDir, "skill-sets", "homes", digest);
  try {
    const profile = await profileFor(deps, driver, thread, selected);
    const skills = profile
      ? profile.skills
      : status.skills.filter((skill) => !set.disabledSkills.includes(skill.name));
    const owned = profile && instance.owned ? await instance.owned(profile) : undefined;
    // Serialize rebuilds of a shared home; each caller still sees new real-home entries.
    const previous = builds.get(outputPath) ?? Promise.resolve(undefined);
    const build = previous
      .catch(() => undefined)
      .then(() =>
        buildSkillSetHome({
          realHome: instance.realHome,
          skillsEntry: instance.skillsEntry,
          ...(instance.privateEntries ? { privateEntries: instance.privateEntries } : {}),
          ...(owned ? { owned } : {}),
          outputPath,
          skills,
        }),
      );
    builds.set(outputPath, build);
    let home: Awaited<ReturnType<typeof buildSkillSetHome>>;
    try {
      home = await build;
    } finally {
      if (builds.get(outputPath) === build) builds.delete(outputPath);
    }
    if (home.foreignEntries.length)
      deps.warn(
        `Skill set ${id} retained provider-created entries: ${home.foreignEntries.join(", ")}`,
      );
    for (const change of home.ownedChanges)
      deps.warn(
        `Agent profile ${id}: ${change.entry} was changed during a session${
          change.keys?.length ? ` (keys: ${change.keys.join(", ")})` : ""
        }; that change was replaced by the profile's copy`,
      );
    return {
      homePath: home.homePath,
      skillsDir: NodePath.join(home.homePath, instance.skillsEntry),
      skills,
      profile,
      ownedChanges: home.ownedChanges,
    };
  } catch (error) {
    deps.warn(`Could not build skill set ${id}; using provider home: ${String(error)}`);
    return;
  }
}
/** Replace only user-level skills; leave project and plugin discoveries intact. */
export function filterSkillSetSnapshot<
  T extends { readonly skills: readonly ServerProviderSkill[] },
>(snapshot: T, resolved: ResolvedSkillSetHome | undefined): T {
  if (!resolved) return snapshot;
  return {
    ...snapshot,
    skills: [
      ...snapshot.skills.filter((skill) => skill.scope !== "user" && skill.scope !== "global"),
      ...resolved.skills.map((skill) => ({
        name: skill.name,
        description: skill.description || undefined,
        path: NodePath.join(resolved.skillsDir, skill.name, "SKILL.md"),
        scope: "user",
        enabled: true,
        userInvocationOnly: skill.commandOnly,
      })),
    ],
  };
}
