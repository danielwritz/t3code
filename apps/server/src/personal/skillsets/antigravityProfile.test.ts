// @effect-diagnostics nodeBuiltinImport:off -- Real folders and links, as agy reads them.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { prepareAntigravityProfile } from "../../provider/antigravityAuthSupport.ts";
import {
  makeAntigravitySkillSetIntegration,
  resolveAntigravitySkillSetProfile,
} from "./antigravity.ts";
import { resolveHome } from "./resolver.ts";
import * as SkillSets from "./runtime.ts";
import { hashTree, write } from "./testFakeMachine.ts";

const skill = (name: string) => `---\nname: ${name}\ndescription: fixture\n---\n`;
const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await NodeFSP.readFile(file, "utf8"));
const exists = (file: string) =>
  NodeFSP.lstat(file).then(
    () => true,
    () => false,
  );

const fixture = Effect.fn("fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const instance = NodePath.join(root, "instance");
  const userHome = NodePath.join(root, "user");
  const profile = NodePath.join(root, "profile");
  return yield* Effect.promise(async () => {
    // The instance folder T3 builds today: copied rules, a personal plugin, other settings.
    await write(NodePath.join(instance, "GEMINI.md"), "instance rules");
    await write(NodePath.join(instance, "AGENTS.md"), "instance agents rules");
    await write(NodePath.join(instance, "skills", "stray", "SKILL.md"), skill("stray"));
    await write(NodePath.join(instance, "config", "hooks.json"), '{"instance":{}}');
    await write(
      NodePath.join(instance, "config", "mcp_config.json"),
      '{"mcpServers":{"personal":{"command":"node"}}}',
    );
    await write(
      NodePath.join(instance, "config", "config.json"),
      JSON.stringify({
        userSettings: { remoteControlHostname: "fixture-host" },
        plugins: { swarm: { enabled: true }, demo: { enabled: true } },
      }),
    );
    await write(NodePath.join(instance, "config", "plugins", "demo", "plugin.json"), "{}");
    await write(NodePath.join(instance, "config", "plugins", "other", "plugin.json"), "{}");
    await NodeFSP.mkdir(profile, { recursive: true });
    return { root, instance, userHome, profile };
  });
});

function serviceFor(root: string, profile: string, ignoreProjectInstructions = false) {
  return Layer.mock(SkillSets.SkillSets)({
    statuses: Effect.succeed([]),
    resolveHome: (driver, instance, thread) =>
      Effect.promise(async () =>
        resolveHome(
          {
            stateDir: NodePath.join(root, "state"),
            settings: {
              skillSetsEnabled: true,
              defaultSkillSetId: "alpha",
              skillSets: {
                alpha: {
                  name: "Alpha",
                  source: { kind: "local", path: profile },
                  enabled: true,
                  autoSync: false,
                  disabledSkills: [],
                  ignoreProjectInstructions,
                },
              },
            },
            statuses: [
              {
                id: "alpha",
                state: "local",
                ready: true,
                commit: null,
                commitDate: null,
                lastChecked: null,
                error: null,
                skills: (await exists(NodePath.join(profile, "skills", "alpha")))
                  ? [
                      {
                        name: "alpha",
                        description: "fixture",
                        commandOnly: false,
                        targetPath: NodePath.join(profile, "skills", "alpha"),
                      },
                    ]
                  : [],
              },
            ],
            warn: () => {},
          },
          driver,
          instance,
          thread,
        ),
      ),
  });
}

const build = (root: string, instance: string, profile: string, userHome: string) =>
  Effect.gen(function* () {
    return yield* resolveAntigravitySkillSetProfile(
      yield* SkillSets.SkillSets,
      "instance",
      instance,
      {},
      userHome,
    );
  }).pipe(Effect.provide(serviceFor(root, profile)));

it.layer(NodeServices.layer)("Antigravity agent profiles", (it) => {
  it.effect("an empty profile builds a stock agent home: no rules, hooks, MCP or plugins", () =>
    Effect.gen(function* () {
      const { root, instance, userHome, profile } = yield* fixture();
      const before = yield* Effect.promise(() => hashTree(instance));
      const resolved = yield* build(root, instance, profile, userHome);
      expect(resolved?.profile).toBeDefined();
      const home = resolved!.homePath;
      const config = NodePath.join(home, "config");
      yield* Effect.promise(async () => {
        for (const entry of ["GEMINI.md", "AGENTS.md", "skills"])
          expect(await exists(NodePath.join(home, entry))).toBe(false);
        expect(await exists(NodePath.join(config, "hooks.json"))).toBe(false);
        expect(await readJson(NodePath.join(config, "mcp_config.json"))).toEqual({
          mcpServers: {},
        });
        expect(await readJson(NodePath.join(config, "config.json"))).toEqual({
          userSettings: { remoteControlHostname: "fixture-host" },
          plugins: { demo: { enabled: false }, other: { enabled: false } },
        });
        expect(await readJson(NodePath.join(config, "skills.json"))).toEqual({ entries: [] });
        expect(await hashTree(instance)).toEqual(before);
      });
    }),
  );

  it.effect(
    "a full profile loads exactly its own instructions, hooks, MCP servers and plugins",
    () =>
      Effect.gen(function* () {
        const { root, instance, userHome, profile } = yield* fixture();
        const hooks = {
          guard: { PreToolUse: [{ matcher: "run_command", hooks: [{ command: "node g.mjs" }] }] },
        };
        yield* Effect.promise(async () => {
          await write(NodePath.join(profile, "instructions.md"), "shared rules");
          await write(NodePath.join(profile, "GEMINI.md"), "profile gemini rules");
          await write(NodePath.join(profile, "skills", "alpha", "SKILL.md"), skill("alpha"));
          await write(NodePath.join(profile, "plugins.json"), '{"antigravity":["demo"]}');
          await write(NodePath.join(profile, "hooks", "antigravity.json"), JSON.stringify(hooks));
          await write(
            NodePath.join(profile, "mcp.json"),
            JSON.stringify({
              mcpServers: {
                local: { type: "stdio", command: "node", args: ["m.mjs"], env: { K: "v" } },
                remote: { type: "http", url: "https://mcp.example/mcp", headers: { A: "b" } },
              },
            }),
          );
        });
        const resolved = yield* build(root, instance, profile, userHome);
        const home = resolved!.homePath;
        const config = NodePath.join(home, "config");
        yield* Effect.promise(async () => {
          expect(await NodeFSP.readFile(NodePath.join(home, "GEMINI.md"), "utf8")).toBe(
            "profile gemini rules",
          );
          expect(await exists(NodePath.join(home, "AGENTS.md"))).toBe(false);
          expect(await readJson(NodePath.join(config, "hooks.json"))).toEqual(hooks);
          expect(await readJson(NodePath.join(config, "mcp_config.json"))).toEqual({
            mcpServers: {
              local: { command: "node", args: ["m.mjs"], env: { K: "v" } },
              remote: { url: "https://mcp.example/mcp", headers: { A: "b" } },
            },
          });
          const settings = (await readJson(NodePath.join(config, "config.json"))) as {
            plugins: unknown;
          };
          expect(settings.plugins).toEqual({ demo: { enabled: true }, other: { enabled: false } });
          const entries = (
            (await readJson(NodePath.join(config, "skills.json"))) as {
              entries: { path: string }[];
            }
          ).entries.map((entry) => NodePath.resolve(config, entry.path));
          expect(entries).toEqual([NodePath.join(profile, "skills", "alpha")]);
        });

        // Removing the profile's hooks removes the generated file on the next build.
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(profile, "hooks"), { recursive: true }),
        );
        const again = yield* build(root, instance, profile, userHome);
        expect(again?.homePath).toBe(home);
        expect(yield* Effect.promise(() => exists(NodePath.join(config, "hooks.json")))).toBe(
          false,
        );
      }),
  );

  it.effect("plugins come from the real home when the instance has none installed", () =>
    Effect.gen(function* () {
      const { root, instance, userHome, profile } = yield* fixture();
      yield* Effect.promise(async () => {
        await NodeFSP.rm(NodePath.join(instance, "config", "plugins"), { recursive: true });
        await write(
          NodePath.join(userHome, ".gemini", "config", "plugins", "real", "plugin.json"),
          "{}",
        );
        await write(NodePath.join(profile, "plugins.json"), '{"antigravity":["real"]}');
      });
      const resolved = yield* build(root, instance, profile, userHome);
      const config = NodePath.join(resolved!.homePath, "config");
      yield* Effect.promise(async () => {
        expect(await NodeFSP.realpath(NodePath.join(config, "plugins"))).toBe(
          await NodeFSP.realpath(NodePath.join(userHome, ".gemini", "config", "plugins")),
        );
        expect(
          ((await readJson(NodePath.join(config, "config.json"))) as { plugins: unknown }).plugins,
        ).toEqual({ real: { enabled: true } });
      });
    }),
  );

  it.effect("the session identity changes when a profile part changes", () =>
    Effect.gen(function* () {
      const { root, instance, userHome, profile } = yield* fixture();
      const identity = Effect.gen(function* () {
        const integration = yield* makeAntigravitySkillSetIntegration(
          "instance",
          instance,
          userHome,
        );
        return yield* integration.sessionInputIdentity({});
      }).pipe(Effect.provide(serviceFor(root, profile)));
      yield* Effect.promise(() => write(NodePath.join(profile, "GEMINI.md"), "first"));
      const first = yield* identity;
      yield* Effect.promise(() => write(NodePath.join(profile, "GEMINI.md"), "second"));
      const second = yield* identity;
      expect(first).toBeDefined();
      expect(second).not.toBe(first);
    }),
  );

  it.effect("with no profile picked, the real hooks file reaches T3's Antigravity home", () =>
    Effect.gen(function* () {
      const { instance, userHome } = yield* fixture();
      const realHooks = '{"outside-post-guard":{"PreToolUse":[]}}';
      yield* Effect.promise(async () => {
        await NodeFSP.rm(NodePath.join(instance, "config", "hooks.json"));
        await write(NodePath.join(userHome, ".gemini", "config", "hooks.json"), realHooks);
      });
      yield* prepareAntigravityProfile({
        profileDirectory: instance,
        userHome,
        platform: "win32",
        runtimeExecutablePath: process.execPath,
      });
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(instance, "config", "hooks.json"), "utf8"),
        ),
      ).toBe(realHooks);
    }),
  );

  it.effect(
    "ignoring project instructions runs agy in a mirror that git maps to the checkout",
    () =>
      Effect.gen(function* () {
        const { root, instance, userHome, profile } = yield* fixture();
        const project = NodePath.join(root, "project");
        yield* Effect.promise(async () => {
          await write(NodePath.join(project, "GEMINI.md"), "repo rules");
          await write(
            NodePath.join(project, ".agents", "skills", "repo", "SKILL.md"),
            skill("repo"),
          );
          await write(NodePath.join(project, "src", "main.txt"), "main");
          NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: project });
        });
        const input = {
          cwd: project,
          threadId: "thread-1",
          processEnvironment: { KEEP: "1" } as NodeJS.ProcessEnv,
        };
        const run = (ignore: boolean) =>
          Effect.gen(function* () {
            const integration = yield* makeAntigravitySkillSetIntegration(
              "instance",
              instance,
              userHome,
            );
            return yield* integration.workspace(input);
          }).pipe(Effect.provide(serviceFor(root, profile, ignore)));
        expect(yield* run(false)).toBe(input);
        const mirrored = yield* run(true);
        expect(mirrored.cwd).not.toBe(project);
        expect(mirrored.threadId).toBe("thread-1");
        expect(mirrored.processEnvironment.KEEP).toBe("1");
        yield* Effect.promise(async () => {
          expect((await NodeFSP.readdir(mirrored.cwd)).toSorted()).toEqual([".git", "src"]);
          expect(await NodeFSP.realpath(mirrored.processEnvironment.GIT_WORK_TREE!)).toBe(
            await NodeFSP.realpath(project),
          );
          expect(await NodeFSP.realpath(mirrored.processEnvironment.GIT_DIR!)).toBe(
            await NodeFSP.realpath(NodePath.join(project, ".git")),
          );
        });
      }),
  );
});
