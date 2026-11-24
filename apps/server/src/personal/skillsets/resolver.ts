// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Pure Node filesystem/process modules are tested on native links and injected time.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import type {
  ServerProviderSkill,
  SkillSetConfig,
  SkillSetStatus,
  SkillSetSkill,
} from "@t3tools/contracts";
import { buildSkillSetHome } from "./home.ts";

export interface SkillSetThread {
  readonly skillSetId?: string | null | undefined;
}
export interface SkillSetInstance {
  readonly instanceId: string;
  readonly realHome: string;
  readonly skillsEntry: string;
  readonly privateEntries?: readonly string[];
}
export interface ResolvedSkillSetHome {
  readonly homePath: string;
  readonly skillsDir: string;
  readonly skills: readonly SkillSetSkill[];
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
}
const builds = new Map<string, Promise<string>>();
export async function resolveHome(
  deps: ResolverDependencies,
  driver: string,
  instance: SkillSetInstance,
  thread: SkillSetThread,
): Promise<ResolvedSkillSetHome | undefined> {
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
  const skills = status.skills.filter((skill) => !set.disabledSkills.includes(skill.name));
  const digest = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([driver, instance.instanceId, instance.realHome, id]))
    .digest("hex")
    .slice(0, 24);
  const outputPath = NodePath.join(deps.stateDir, "skill-sets", "homes", digest);
  try {
    // Serialize rebuilds of a shared home; each caller still sees new real-home entries.
    const previous = builds.get(outputPath) ?? Promise.resolve("");
    const build = previous
      .catch(() => "")
      .then(() => buildSkillSetHome({ ...instance, outputPath, skills }));
    builds.set(outputPath, build);
    let homePath: string;
    try {
      homePath = await build;
    } finally {
      if (builds.get(outputPath) === build) builds.delete(outputPath);
    }
    return { homePath, skillsDir: NodePath.join(homePath, instance.skillsEntry), skills };
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
