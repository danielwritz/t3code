import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeClaudeSkillSets } from "./claude.ts";
import { resolveHome } from "./resolver.ts";
import * as SkillSets from "./runtime.ts";
import { linkClaudeGlobalConfig } from "./claudeHome.ts";

const defaultSettings = Schema.decodeSync(ClaudeSettings)({});

it.layer(NodeServices.layer)("Claude skill sets", (it) => {
  it.effect("shares the default global config when menu and turn initialization race", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "claude-global-link-" });
      const built = path.join(root, "built");
      yield* fs.makeDirectory(built);
      yield* fs.writeFileString(path.join(root, ".claude.json"), "{}");
      yield* Effect.promise(() => Promise.all([
        linkClaudeGlobalConfig(built, root),
        linkClaudeGlobalConfig(built, root),
      ]));
      expect(yield* fs.realPath(path.join(built, ".claude.json"))).toBe(
        yield* fs.realPath(path.join(root, ".claude.json")),
      );
    }),
  );
  it.effect("keeps the exact environment when off or resolution fails", () =>
    Effect.gen(function* () {
      const settings = defaultSettings;
      const environment = { CLAUDE_CONFIG_DIR: "/original", EXTRA: "kept" };
      for (const resolveHome of [() => Effect.undefined, () => Effect.die("broken")]) {
        const integration = yield* makeClaudeSkillSets("instance", settings, environment).pipe(
          Effect.provideService(SkillSets.SkillSets, {
            resolveHome,
            statuses: Effect.succeed([]),
            syncNow: () => Effect.succeed([]),
            changes: Stream.empty,
          }),
        );
        expect(yield* integration.queryEnvironment(environment, { skillSetId: "alpha" })).toBe(
          environment,
        );
        const invocation = { permissions: { defaultMode: "default" }, syncClaudeAiPlugins: true };
        expect(integration.querySettings(environment, invocation)).toBe(invocation);
        expect(integration.querySettings(environment, undefined)).toBeUndefined();
      }
    }),
  );

  it.effect(
    "replaces only user skills for both homes and switches the next turn with shared history",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "claude-sets-" });
        const userHome = path.join(root, "user");
        const workspace = path.join(root, "workspace");
        const write = (file: string, text: string) =>
          fs
            .makeDirectory(path.dirname(file), { recursive: true })
            .pipe(Effect.andThen(fs.writeFileString(file, text)));
        const skill = (folder: string, name: string) =>
          write(
            path.join(folder, name, "SKILL.md"),
            `---\nname: ${name}\ndescription: ${name}\n---\n`,
          );
        yield* skill(path.join(workspace, ".claude", "skills"), "project-skill");
        yield* write(
          path.join(userHome, ".claude.json"),
          '{"mcpServers":{"sample":{"command":"example"}}}',
        );
        const skills: Array<{
          name: string;
          targetPath: string;
          description: string;
          commandOnly: boolean;
        }> = [];
        for (const name of ["alpha", "beta", "disabled"]) {
          const targetPath = path.join(root, "set", name);
          yield* skill(path.dirname(targetPath), name);
          skills.push({ name, targetPath, description: name, commandOnly: false });
        }
        for (const custom of [false, true]) {
          const realHome = path.join(userHome, custom ? "custom" : ".claude");
          yield* skill(path.join(realHome, "skills"), "original-skill");
          yield* write(path.join(realHome, "CLAUDE.md"), "memory preserved");
          yield* write(path.join(realHome, "projects", "workspace", "session.jsonl"), "history");
          yield* write(
            path.join(realHome, "settings.json"),
            '{"enabledPlugins":{"sample@store":true},"hooks":{"Stop":[]}}',
          );
          const plugin = path.join(realHome, "plugins", "sample");
          yield* skill(path.join(plugin, "skills"), "plugin-skill");
          yield* write(path.join(plugin, ".claude-plugin", "plugin.json"), '{"name":"sample"}');
          yield* write(
            path.join(realHome, "plugins", "installed_plugins.json"),
            JSON.stringify({
              plugins: { "sample@store": [{ scope: "user", installPath: plugin }] },
            }),
          );
          const config = {
            name: "set",
            enabled: true,
            autoSync: false,
            disabledSkills: ["disabled"],
            source: { kind: "local" as const, path: root },
          };
          const deps = {
            stateDir: path.join(root, "state"),
            settings: {
              skillSetsEnabled: true,
              defaultSkillSetId: "alpha",
              skillSets: { alpha: config, beta: config },
            },
            statuses: ["alpha", "beta"].map((id) => ({
              id,
              state: "local" as const,
              commit: null,
              commitDate: null,
              lastChecked: null,
              error: null,
              skills: skills.filter((s) => s.name === id || s.name === "disabled"),
            })),
            warn: () => {},
          };
          const integration = yield* makeClaudeSkillSets(
            "instance",
            { ...defaultSettings, homePath: custom ? realHome : "" },
            {},
          ).pipe(
            Effect.provideService(HostProcess.HomeDirectory, userHome),
            Effect.provideService(SkillSets.SkillSets, {
              resolveHome: (driver, instance, thread) =>
                Effect.promise(() => resolveHome(deps, driver, instance, thread)),
              statuses: Effect.succeed([]),
              syncNow: () => Effect.succeed([]),
              changes: Stream.empty,
            }),
          );
          const first = yield* integration.queryEnvironment({ EXTRA: "kept" }, {});
          const second = yield* integration.queryEnvironment({}, { skillSetId: "beta" });
          expect(first.CLAUDE_CONFIG_DIR).not.toBe(second.CLAUDE_CONFIG_DIR);
          expect(first.EXTRA).toBe("kept");
          expect(first.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(custom ? realHome : "");
          const invocation = {
            permissions: { defaultMode: "default" },
            syncClaudeAiPlugins: true,
            env: { TEST_VALUE: "kept" },
          };
          expect(integration.querySettings(first, invocation)).toEqual({
            ...invocation,
            syncClaudeAiSkills: false,
          });
          for (const home of [first.CLAUDE_CONFIG_DIR!, second.CLAUDE_CONFIG_DIR!]) {
            if (!custom) {
              expect(yield* fs.realPath(path.join(home, ".claude.json"))).toBe(
                yield* fs.realPath(path.join(userHome, ".claude.json")),
              );
            }
            expect(yield* fs.readFileString(path.join(home, "CLAUDE.md"))).toBe("memory preserved");
            expect(yield* fs.readFileString(path.join(home, "settings.json"))).toBe(
              yield* fs.readFileString(path.join(realHome, "settings.json")),
            );
            expect(yield* fs.realPath(path.join(home, "projects"))).toBe(
              yield* fs.realPath(path.join(realHome, "projects")),
            );
          }
          const names = (yield* integration
            .discover(workspace, { skillSetId: "beta" })
            .pipe(Effect.provideService(HostProcess.Platform, "win32"))).map((s) => s.name);
          expect(names).toEqual(
            expect.arrayContaining(["beta", "project-skill", "sample:plugin-skill"]),
          );
          expect(names.some((name) => ["alpha", "disabled", "original-skill"].includes(name))).toBe(
            false,
          );
        }
      }),
  );
});
