import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { makeCodexSkillSets } from "./codex.ts";
import { codexSkillRules } from "./codexIsolation.ts";
import * as SkillSets from "./runtime.ts";
import { resolveHome } from "./resolver.ts";
import { buildSkillSetHome } from "./home.ts";
import { codexProjectSkillPaths } from "./codexOrigins.ts";
const decodeSettings = Schema.decodeEffect(CodexSettings);

describe("Codex skill-set launch", () => {
  it.effect(
    "preserves a project alias when native discovery deduplicates it into user scope, within custom project boundaries",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const project = path.join(root, "project");
        const cwd = path.join(project, "nested");
        const target = path.join(root, "canonical-skill");
        const empty = path.join(root, "empty-home");
        yield* fs.makeDirectory(cwd, { recursive: true });
        yield* fs.makeDirectory(target);
        yield* fs.makeDirectory(empty);
        yield* fs.writeFileString(path.join(project, "project.marker"), "fixture");
        yield* fs.writeFileString(path.join(target, "SKILL.md"), "fixture");
        yield* Effect.promise(() =>
          buildSkillSetHome({
            realHome: empty,
            outputPath: path.join(project, ".agents"),
            skillsEntry: "skills",
            skills: [{ name: "alias", targetPath: target }],
          }),
        );
        const preserved = yield* codexProjectSkillPaths(cwd, ["project.marker"]);
        expect(preserved).toEqual([yield* fs.realPath(path.join(target, "SKILL.md"))]);
        expect(yield* codexProjectSkillPaths(cwd, [])).toEqual([]);
        const override = JSON.stringify(
          yield* codexSkillRules(
            [
              {
                name: "project-alias",
                path: path.join(target, "SKILL.md"),
                scope: "user",
                enabled: true,
              },
              {
                name: "outside",
                path: path.join(root, "outside", "SKILL.md"),
                scope: "user",
                enabled: true,
              },
            ],
            [],
            preserved,
          ),
        );
        expect(override).not.toContain("canonical-skill");
        expect(override).toContain("outside");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("keeps the upstream launch settings when no skill-set service is installed", () =>
    Effect.gen(function* () {
      const settings = yield* decodeSettings({ homePath: "original-home" });
      const sets = yield* makeCodexSkillSets(ProviderInstanceId.make("codex-alpha"));
      const launch = yield* sets.launch(settings, {});
      expect(launch.settings).toBe(settings);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "isolates a picked home, keeps its private login linked, and fails open when disabled or resolution fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const home = path.join(root, "instance");
        const skill = path.join(root, "selected");
        yield* fs.makeDirectory(path.join(home, "sessions"), { recursive: true });
        yield* fs.makeDirectory(skill);
        yield* fs.writeFileString(
          path.join(skill, "SKILL.md"),
          "---\nname: selected\ndescription: Fixture\n---\n",
        );
        yield* fs.writeFileString(path.join(home, "auth.json"), "{}");
        const settings = yield* decodeSettings({ homePath: home });
        let enabled = false;
        let broken = false;
        let keyring = false;
        const service = SkillSets.SkillSets.of({
          statuses: Effect.succeed([]),
          changes: Stream.empty,
          syncNow: () => Effect.succeed([]),
          resolveHome: (driver, instance, thread) =>
            broken
              ? Effect.die("fixture resolver failure")
              : Effect.promise(() =>
                  resolveHome(
                    {
                      stateDir: root,
                      settings: {
                        skillSetsEnabled: enabled,
                        defaultSkillSetId: "alpha",
                        skillSets: {
                          alpha: {
                            name: "Alpha",
                            source: { kind: "local", path: root },
                            enabled: true,
                            autoSync: false,
                            disabledSkills: [],
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
                          skills: [
                            {
                              name: "selected",
                              description: "Fixture",
                              commandOnly: false,
                              targetPath: skill,
                            },
                          ],
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
        const sets = yield* makeCodexSkillSets(ProviderInstanceId.make("codex-alpha"), {}, () =>
          Effect.succeed({ skills: [], homeScopedCredentials: keyring }),
        ).pipe(Effect.provideService(SkillSets.SkillSets, service));
        expect((yield* sets.launch(settings, {})).settings).toBe(settings);
        expect(yield* fs.exists(path.join(home, "archived_sessions"))).toBe(false);
        expect(yield* fs.exists(path.join(root, "skill-sets", "homes"))).toBe(false);
        enabled = true;
        const selected = yield* sets.launch(settings, {});
        expect(selected.settings.homePath).not.toBe(home);
        expect(yield* fs.realPath(path.join(selected.settings.homePath, "auth.json"))).toBe(
          path.join(home, "auth.json"),
        );
        expect(yield* fs.realPath(path.join(selected.settings.homePath, "sessions"))).toBe(
          path.join(home, "sessions"),
        );
        expect(selected.environment.CODEX_SQLITE_HOME).toBe(home);
        expect(yield* fs.realPath(path.join(selected.settings.homePath, "archived_sessions"))).toBe(
          path.join(home, "archived_sessions"),
        );
        expect(
          yield* fs.realPath(path.join(selected.settings.homePath, "thread-writer-locks")),
        ).toBe(path.join(home, "thread-writer-locks"));
        yield* fs.writeFileString(
          path.join(selected.settings.homePath, "future-runtime-state"),
          "fixture",
        );
        expect((yield* sets.launch(settings, {})).settings.homePath).toBe(
          selected.settings.homePath,
        );
        keyring = true;
        expect((yield* sets.launch(settings, {})).settings).toBe(settings);
        keyring = false;
        broken = true;
        expect((yield* sets.launch(settings, {})).settings).toBe(settings);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "preserves canonical overlaps with the picked set, project and plugins while disabling extra user skills",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const picked = path.join(root, "picked");
        yield* fs.makeDirectory(picked);
        const document = path.join(picked, "SKILL.md");
        yield* fs.writeFileString(document, "fixture");
        const alias = path.join(root, "alias.md");
        yield* fs.symlink(document, alias);
        const inventory = [
          { name: "picked", path: alias, scope: "user", enabled: true },
          { name: "picked", path: document, scope: "user", enabled: true },
          { name: "extra", path: path.join(root, "extra.md"), scope: "user", enabled: true },
          { name: "project", path: path.join(root, "project.md"), scope: "repo", enabled: true },
          {
            name: "project-alias",
            path: path.join(root, "project.md"),
            scope: "user",
            enabled: true,
          },
          {
            name: "plugin",
            path: path.join(root, "plugin.md"),
            scope: "user",
            enabled: true,
            pluginId: "plugin-alpha",
          },
          {
            name: "plugin-alias",
            path: path.join(root, "plugin.md"),
            scope: "user",
            enabled: true,
          },
        ];
        const override = JSON.stringify(
          yield* codexSkillRules(inventory, [{ targetPath: picked }]),
        );
        expect(override).toContain("extra.md");
        expect(override).not.toContain("project.md");
        expect(override).not.toContain("plugin.md");
        expect(override).not.toContain("alias.md");
        expect(override).not.toContain("SKILL.md");
        const reenabled = yield* codexSkillRules(
          inventory.map((skill) =>
            skill.name === "picked" ? { ...skill, enabled: false } : skill,
          ),
          [{ targetPath: picked }],
        );
        expect(reenabled.filter((rule) => rule.path.endsWith("SKILL.md"))).toEqual([
          { path: yield* fs.realPath(document), enabled: true },
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
