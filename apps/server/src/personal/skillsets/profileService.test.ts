// @effect-diagnostics nodeBuiltinImport:off -- Real folders on disk.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { SkillSetConfig } from "@t3tools/contracts";
import { readMachineInventory } from "./inventory.ts";
import { makeAgentProfileService } from "./profileService.ts";
import { ThreadProfileOptions } from "./profileState.ts";
import { hashTree, makeFakeMachine, write } from "./testFakeMachine.ts";

async function setup() {
  const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "profile-service-"));
  const machine = await makeFakeMachine();
  const local = NodePath.join(stateDir, "local-set");
  await write(NodePath.join(local, "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
  await write(
    NodePath.join(local, "mcp.json"),
    JSON.stringify({ mcpServers: { docs: { url: "https://docs.example" } } }),
  );
  let sets: Record<string, SkillSetConfig> = {
    beta: {
      name: "Beta",
      source: { kind: "local", path: local },
      enabled: true,
      autoSync: false,
      disabledSkills: [],
    },
  };
  const synced: string[] = [];
  const service = makeAgentProfileService({
    stateDir,
    skillSets: async () => sets,
    saveSkillSet: async (id, config) => {
      sets = { ...sets, [id]: config };
    },
    statuses: () => [],
    syncNow: async (id) => {
      synced.push(id);
    },
    inventory: () => readMachineInventory(machine.paths),
    threadOptions: new ThreadProfileOptions(
      NodePath.join(stateDir, "skill-sets", "thread-options.json"),
    ),
  });
  return { stateDir, machine, service, sets: () => sets, synced };
}

it("lists profiles, switches items and the profile's ignore-project flag through the side state", async () => {
  const { service, sets } = await setup();
  const [beta] = await service.list();
  expect(beta?.items.map((item) => `${item.id}:${item.enabled}`)).toEqual([
    "skill:alpha:true",
    "mcp:docs:true",
    "policy:claude:hook:policy:policy.json:PreToolUse:0:false",
    "policy:codex:hook:policy:hooks.json:PreToolUse:0:false",
  ]);
  const policy = "policy:codex:hook:policy:hooks.json:PreToolUse:0";
  expect(
    (await service.setItemEnabled("beta", policy, true)).items.find((item) => item.id === policy)
      ?.enabled,
  ).toBe(true);
  expect(sets().beta?.enabledItems).toEqual([policy]);
  await service.setItemEnabled("beta", policy, false);
  expect(sets().beta?.enabledItems).toEqual([]);
  await service.setItemEnabled("beta", "mcp:docs", false);
  const view = await service.setItemEnabled("beta", "skill:alpha", false);
  expect(view.items.slice(0, 2).map((item) => `${item.id}:${item.enabled}`)).toEqual([
    "skill:alpha:false",
    "mcp:docs:false",
  ]);
  expect(sets().beta).toMatchObject({ disabledSkills: ["alpha"] });
  expect(sets().beta?.disabledItems).toContain("mcp:docs");
  await service.setItemEnabled("beta", "skill:alpha", true);
  expect(sets().beta?.disabledSkills).toEqual([]);
  expect((await service.setIgnoreProject("beta", true)).ignoreProjectInstructions).toBe(true);
  expect(sets().beta?.ignoreProjectInstructions).toBe(true);
  await expect(service.setItemEnabled("beta", "mcp:absent", false)).rejects.toThrow("no item");
  await expect(service.setIgnoreProject("absent", true)).rejects.toThrow("No agent profile");
});

it("keeps a thread's ignore-project choice in its own side file", async () => {
  const { service, stateDir } = await setup();
  expect(await service.threadOptions("thread-a")).toEqual({
    threadId: "thread-a",
    ignoreProjectInstructions: null,
  });
  await service.setThreadIgnoreProject("thread-a", true);
  expect(
    JSON.parse(
      await NodeFSP.readFile(NodePath.join(stateDir, "skill-sets", "thread-options.json"), "utf8"),
    ),
  ).toEqual({ "thread-a": { ignoreProjectInstructions: true } });
  expect((await service.threadOptions("thread-b")).ignoreProjectInstructions).toBeNull();
});

it("creates a profile from references that stays a pointer to the real setup", async () => {
  const { service, machine, sets, synced, stateDir } = await setup();
  const before = await hashTree(machine.root);
  const view = await service.createFromReferences("mine", "Mine", [
    "claude:mcp:calendar",
    "codex:instructions:AGENTS.md",
  ]);
  expect(view.items.map((item) => `${item.id}:${item.origin}`)).toEqual([
    "policy:claude:hook:policy:policy.json:PreToolUse:0:machine-policy",
    "policy:codex:hook:policy:hooks.json:PreToolUse:0:machine-policy",
    "ref:claude:mcp:calendar:reference",
    "ref:codex:instructions:AGENTS.md:reference",
  ]);
  expect(sets().mine).toMatchObject({ name: "Mine", source: { kind: "local" }, enabled: true });
  expect(synced).toEqual(["mine"]);
  const folder = NodePath.join(stateDir, "skill-sets", "profiles", "mine");
  expect(await NodeFSP.readdir(folder)).toEqual(["refs.json"]);
  expect(await NodeFSP.readFile(NodePath.join(folder, "refs.json"), "utf8")).not.toContain(
    "s3cret",
  );
  expect(await hashTree(machine.root)).toEqual(before);
  await expect(service.createFromReferences("mine", "Again", [])).rejects.toThrow("exists");
  const kept = await service.createFromReferences("policy", "Policy", [
    "codex:hook:policy:hooks.json:PreToolUse:0",
  ]);
  expect(kept.items.filter((item) => item.enabled).map((item) => item.id)).toEqual([
    "policy:codex:hook:policy:hooks.json:PreToolUse:0",
  ]);
  await expect(
    service.createFromReferences("absent", "Absent", ["claude:mcp:none"]),
  ).rejects.toThrow("not found");
  await expect(service.createFromReferences("../up", "Up", [])).rejects.toThrow("Invalid");
  expect(Object.keys(sets())).toEqual(["beta", "mine", "policy"]);
});
