// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Pure Node filesystem/process modules are tested on native links and injected time.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { resolveHome, filterSkillSetSnapshot } from "./resolver.ts";
it("falls back when off, unpicked, not ready or build fails, and omits disabled skills", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "resolve-"));
  const home = NodePath.join(root, "real");
  const target = NodePath.join(root, "skill");
  await NodeFSP.mkdir(home);
  await NodeFSP.mkdir(target);
  const config = {
    name: "Alpha",
    enabled: true,
    autoSync: true,
    disabledSkills: ["off"],
    source: { kind: "local" as const, path: root },
  };
  const settings = {
    skillSetsEnabled: true,
    defaultSkillSetId: "alpha",
    skillSets: { alpha: config },
  };
  const status = {
    id: "alpha",
    state: "local" as const,
    commit: null,
    commitDate: null,
    lastChecked: null,
    error: null,
    skills: [
      { name: "on", description: "On", commandOnly: false, targetPath: target },
      { name: "off", description: "Off", commandOnly: false, targetPath: target },
    ],
  };
  const warnings: string[] = [];
  const deps = {
    stateDir: root,
    settings,
    statuses: [status],
    warn: (message: string) => warnings.push(message),
  };
  const instance = { instanceId: "one", realHome: home, skillsEntry: "skills" };
  expect(
    await resolveHome(
      { ...deps, settings: { ...settings, skillSetsEnabled: false } },
      "codex",
      instance,
      {},
    ),
  ).toBeUndefined();
  expect(
    await resolveHome(
      { ...deps, settings: { ...settings, defaultSkillSetId: null } },
      "codex",
      instance,
      {},
    ),
  ).toBeUndefined();
  expect(await resolveHome({ ...deps, statuses: [] }, "codex", instance, {})).toBeUndefined();
  expect(warnings).toHaveLength(1);
  const result = await resolveHome(deps, "codex", instance, {});
  expect(result?.skills.map((s) => s.name)).toEqual(["on"]);
  if (!result) throw new Error("Expected selected home");
  await NodeFSP.mkdir(NodePath.join(result.skillsDir, "synced"));
  for (const _build of [1, 2]) {
    expect((await resolveHome(deps, "codex", instance, {}))?.homePath).toBe(result.homePath);
    expect(warnings.at(-1)).toContain("retained provider-created entries: synced");
  }
  expect(
    await resolveHome(deps, "codex", { ...instance, realHome: NodePath.join(root, "missing") }, {}),
  ).toBeUndefined();
  expect(warnings).toHaveLength(4);
  const snapshot = {
    skills: [
      { name: "old", path: NodePath.join(home, "skills", "old"), enabled: true, scope: "user" },
      {
        name: "project",
        path: NodePath.join(root, "project", "SKILL.md"),
        enabled: true,
        scope: "project",
      },
    ],
  };
  expect(filterSkillSetSnapshot(snapshot, result).skills.map((s) => s.name)).toEqual([
    "project",
    "on",
  ]);
  expect(filterSkillSetSnapshot(snapshot, undefined)).toBe(snapshot);
});
