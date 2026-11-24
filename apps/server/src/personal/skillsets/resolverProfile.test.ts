// @effect-diagnostics nodeBuiltinImport:off -- Real folders, real links.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { readMachineInventory } from "./inventory.ts";
import { ThreadProfileOptions } from "./profileState.ts";
import { resolveHome, resolveProfile } from "./resolver.ts";
import { hashTree, makeFakeMachine, write } from "./testFakeMachine.ts";

async function setup() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "resolve-profile-"));
  const machine = await makeFakeMachine();
  const profile = NodePath.join(root, "profile");
  await write(NodePath.join(profile, "CLAUDE.md"), "profile rules");
  await write(
    NodePath.join(profile, "refs.json"),
    JSON.stringify([{ ref: "claude:mcp:calendar" }, { ref: "claude:hook:PreToolUse:0" }]),
  );
  const options = new ThreadProfileOptions(NodePath.join(root, "state", "thread-options.json"));
  const warnings: string[] = [];
  const settings = {
    skillSetsEnabled: true,
    defaultSkillSetId: null,
    skillSets: {
      alpha: {
        name: "Alpha",
        enabled: true,
        autoSync: false,
        disabledSkills: [],
        ignoreProjectInstructions: true,
        source: { kind: "local" as const, path: profile },
      },
    },
  };
  const deps = {
    stateDir: NodePath.join(root, "state"),
    settings,
    statuses: [
      {
        id: "alpha",
        state: "local" as const,
        ready: true,
        commit: null,
        commitDate: null,
        lastChecked: null,
        error: null,
        skills: [],
      },
    ],
    warn: (message: string) => warnings.push(message),
    inventory: () => readMachineInventory(machine.paths),
    threadIgnoresProject: (threadId: string) => options.ignoreProject(threadId),
  };
  return { root, machine, options, warnings, deps };
}

it("applies the profile's ignore-project switch unless the thread overrides it, from the side file", async () => {
  const { options, deps, root } = await setup();
  const thread = { skillSetId: "alpha", threadId: "thread-1" };
  expect((await resolveProfile(deps, "claudeAgent", thread))?.ignoreProjectInstructions).toBe(true);
  await options.setIgnoreProject("thread-1", false);
  const reread = new ThreadProfileOptions(options.path);
  const fresh = { ...deps, threadIgnoresProject: (id: string) => reread.ignoreProject(id) };
  const overridden = await resolveProfile(fresh, "claudeAgent", thread);
  expect(overridden?.ignoreProjectInstructions).toBe(false);
  expect(
    (await resolveProfile(fresh, "claudeAgent", { skillSetId: "alpha", threadId: "thread-2" }))
      ?.ignoreProjectInstructions,
  ).toBe(true);
  await reread.setIgnoreProject("thread-1", null);
  expect((await resolveProfile(fresh, "claudeAgent", thread))?.contentHash).not.toBe(
    overridden?.contentHash,
  );
  expect(JSON.parse(await NodeFSP.readFile(options.path, "utf8"))).toEqual({});
  expect(await resolveProfile(deps, "cursor", thread)).toBeUndefined();
  void root;
});

it("builds owned entries from the resolved profile and warns once about a write made in a session", async () => {
  const { machine, deps, warnings, root } = await setup();
  const realHome = NodePath.join(root, "real-claude");
  await write(NodePath.join(realHome, "CLAUDE.md"), "real rules");
  await write(NodePath.join(realHome, ".credentials.json"), "login");
  const realBefore = await hashTree(realHome);
  const machineBefore = await hashTree(machine.root);
  const instance = {
    instanceId: "one",
    realHome,
    skillsEntry: "skills",
    owned: (profile: NonNullable<Awaited<ReturnType<typeof resolveProfile>>>) => ({
      "CLAUDE.md": profile.instructions
        ? { kind: "file" as const, contents: profile.instructions.text }
        : null,
      "settings.json": {
        kind: "file" as const,
        contents: JSON.stringify({
          hooks: profile.hooksFile,
          mcp: Object.keys(profile.mcpServers),
        }),
      },
    }),
  };
  const thread = { skillSetId: "alpha" };
  const home = await resolveHome(deps, "claudeAgent", instance, thread);
  if (!home) throw new Error(warnings.join("\n"));
  expect(await NodeFSP.readFile(NodePath.join(home.homePath, "CLAUDE.md"), "utf8")).toBe(
    "profile rules",
  );
  expect(
    JSON.parse(await NodeFSP.readFile(NodePath.join(home.homePath, "settings.json"), "utf8")),
  ).toEqual({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node guard.mjs" }] }],
    },
    mcp: ["calendar"],
  });
  expect(
    (await NodeFSP.lstat(NodePath.join(home.homePath, ".credentials.json"))).isSymbolicLink(),
  ).toBe(true);
  await NodeFSP.writeFile(
    NodePath.join(home.homePath, "settings.json"),
    JSON.stringify({ hooks: null, mcp: [], model: "picked-in-session" }),
  );
  await resolveHome(deps, "claudeAgent", instance, thread);
  await resolveHome(deps, "claudeAgent", instance, thread);
  expect(warnings.filter((warning) => warning.includes("changed during a session"))).toEqual([
    "Agent profile alpha: settings.json was changed during a session (keys: hooks, mcp, model); that change was replaced by the profile's copy",
  ]);
  expect(await hashTree(realHome)).toEqual(realBefore);
  expect(await hashTree(machine.root)).toEqual(machineBefore);
});
