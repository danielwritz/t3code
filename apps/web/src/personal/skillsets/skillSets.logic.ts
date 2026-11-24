import type { SkillSetConfig, SkillSetStatus } from "@t3tools/contracts";
import { msg } from "gt-react";
import { deriveProjectIdentity } from "~/projectIdentity";

export function joinSkillSets(
  configs: Readonly<Record<string, SkillSetConfig>>,
  statuses: readonly SkillSetStatus[],
  defaultId: string | null,
  environmentId?: import("@t3tools/contracts").EnvironmentId | null,
) {
  const byId = new Map(statuses.map((status) => [status.id, status]));
  return Object.entries(configs).map(([id, config]) => {
    const status = byId.get(id);
    const identity = deriveProjectIdentity(config.name);
    const skills = (status?.skills ?? []).map((skill) => ({
      ...skill,
      manualOnly: skill.commandOnly,
      enabled: !config.disabledSkills.includes(skill.name),
    }));
    return {
      ...config,
      id,
      status,
      skills,
      isDefault: id === defaultId,
      logo:
        config.logo && config.logo.kind !== "repo-image"
          ? config.logo
          : {
              kind: "repo-image" as const,
              id,
              environmentId: environmentId ?? null,
              revision: JSON.stringify([config.logo, status?.commit, status?.lastChecked]),
              fallback: {
                kind: "monogram" as const,
                text: identity.monogram,
                color: identity.color,
              },
            },
      repo: {
        state: status?.state ?? "syncing",
        label: config.source.kind === "git" ? config.source.url : config.source.path,
        path: config.source.kind === "local" ? config.source.path : "",
        branch: config.source.kind === "git" ? config.source.branch : undefined,
        commit: status?.commit?.slice(0, 8),
        commitDate: status?.commitDate,
      },
    };
  });
}

export type SkillSet = ReturnType<typeof joinSkillSets>[number];
export type SkillSetSkill = SkillSet["skills"][number];

export function activeSkillSet(
  enabled: boolean,
  sets: readonly SkillSet[],
  pick: string | null | undefined,
  defaultId: string | null,
) {
  return enabled ? sets.find((set) => set.enabled && set.id === (pick ?? defaultId)) : undefined;
}

export function skillSetIdFromName(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

export function newSkillSet(
  nameInput: string,
  sourceInput: string,
  existing: Readonly<Record<string, SkillSetConfig>>,
) {
  const name = nameInput.trim();
  const id = skillSetIdFromName(name);
  if (!id) return { error: msg("Enter a name containing letters or numbers.") };
  if (Object.hasOwn(existing, id))
    return { error: msg("A skill set with this name already exists.") };
  let location = sourceInput.trim();
  if (/^github\.com\/[^/]+\/[^/]+\/?$/u.test(location)) location = `https://${location}`;
  let source: SkillSetConfig["source"];
  if (/^(?:[A-Za-z]:[\\/]|\/|~[\\/]|\\\\)/u.test(location)) {
    source = { kind: "local", path: location };
  } else if (/^[\w.-]+@[\w.-]+:[\w./-]+$/u.test(location)) {
    source = { kind: "git", url: location };
  } else {
    const url = URL.parse(location);
    if (
      !url ||
      !["https:", "http:", "ssh:", "git:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname === "/" ||
      (url.username && url.protocol !== "ssh:") ||
      url.password
    ) {
      return { error: msg("Enter a git URL or an absolute local folder path.") };
    }
    source = { kind: "git", url: location };
  }
  return {
    id,
    config: {
      name,
      source,
      enabled: true,
      autoSync: true,
      disabledSkills: [],
    } satisfies SkillSetConfig,
  };
}

export function withSkillSetSettingsScope(pathname: string, upstream: boolean) {
  return pathname === "/settings/skill-sets" || upstream;
}
