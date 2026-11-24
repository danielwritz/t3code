import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerProvider } from "@t3tools/contracts";
import * as SkillSets from "./runtime.ts";
import { antigravitySkillSetSnapshot, resolveAntigravitySkillSetProfile } from "./antigravity.ts";
import { resolveHome } from "./resolver.ts";
import { discoverAntigravitySkills } from "../../provider/Drivers/AntigravitySkills.ts";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
it.layer(NodeServices.layer)("Antigravity skill sets", (it) => {
  it.effect(
    "replaces both native user roots and skills.json entries while retaining project and plugin skills",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const profile = path.join(root, "profile");
        const userHome = path.join(root, "user");
        const cwd = path.join(root, "project");
        const skill = Effect.fn("fixture.skill")(function* (dir: string, name: string) {
          yield* fs.makeDirectory(dir, { recursive: true });
          yield* fs.writeFileString(
            path.join(dir, "SKILL.md"),
            `---\nname: ${name}\ndescription: fixture\n---\n`,
          );
        });
        yield* skill(path.join(profile, "config", "skills", "old"), "old");
        yield* skill(path.join(profile, "antigravity-cli", "skills", "secondary"), "secondary");
        yield* skill(path.join(root, "outside"), "outside");
        yield* fs.writeFileString(
          path.join(profile, "config", "skills.json"),
          JSON.stringify({ entries: [{ path: path.join(root, "outside") }] }),
        );
        yield* skill(
          path.join(profile, "config", "plugins", "plugin", "skills", "plugin-skill"),
          "plugin-skill",
        );
        yield* skill(path.join(cwd, ".agents", "skills", "project-skill"), "project-skill");
        yield* skill(path.join(root, "set", "alpha"), "alpha");
        yield* skill(path.join(root, "set", "beta"), "beta");
        const service = Layer.mock(SkillSets.SkillSets)({
          statuses: Effect.succeed([]),
          resolveHome: (driver, instance, thread) =>
            Effect.promise(() =>
              resolveHome(
                {
                  stateDir: root,
                  settings: {
                    skillSetsEnabled: true,
                    defaultSkillSetId: "alpha",
                    skillSets: {
                      alpha: {
                        name: "Alpha",
                        source: { kind: "local", path: path.join(root, "set") },
                        enabled: true,
                        autoSync: false,
                        disabledSkills: ["beta"],
                      },
                    },
                  },
                  statuses: [
                    {
                      id: "alpha",
                      state: "local",
                      commit: null,
                      commitDate: null,
                      lastChecked: null,
                      error: null,
                      skills: [
                        {
                          name: "alpha",
                          description: "fixture",
                          commandOnly: false,
                          targetPath: path.join(root, "set", "alpha"),
                        },
                        {
                          name: "beta",
                          description: "fixture",
                          commandOnly: false,
                          targetPath: path.join(root, "set", "beta"),
                        },
                        {
                          name: "secondary",
                          description: "overlap",
                          commandOnly: false,
                          targetPath: path.join(profile, "antigravity-cli", "skills", "secondary"),
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
        const resolved = yield* Effect.gen(function* () {
          return yield* resolveAntigravitySkillSetProfile(
            yield* SkillSets.SkillSets,
            "instance",
            profile,
            {},
          );
        }).pipe(Effect.provide(service));
        expect(resolved).toBeDefined();
        const generatedConfig = path.join(resolved!.homePath, "config", "skills.json");
        yield* fs.remove(generatedConfig);
        yield* fs.symlink(path.join(profile, "config", "skills.json"), generatedConfig);
        const again = yield* Effect.gen(function* () {
          return yield* resolveAntigravitySkillSetProfile(
            yield* SkillSets.SkillSets,
            "instance",
            profile,
            {},
          );
        }).pipe(Effect.provide(service));
        expect(again?.homePath).toBe(resolved?.homePath);
        const generated = JSON.parse(
          yield* fs.readFileString(path.join(resolved!.homePath, "config", "skills.json")),
        );
        expect(
          generated.entries.map((entry: { path: string }) =>
            path.resolve(resolved!.homePath, "config", entry.path),
          ),
        ).toEqual([
          path.join(root, "set", "alpha"),
          path.join(profile, "antigravity-cli", "skills", "secondary"),
        ]);
        const skills = yield* discoverAntigravitySkills({
          cwd,
          userHome,
          profileDirectory: resolved!.homePath,
          userGeminiHome: resolved!.homePath,
        });
        expect(skills.map((s) => s.name)).toEqual([
          "alpha",
          "plugin-skill",
          "project-skill",
          "secondary",
        ]);
        const baseline = decodeProvider({
          instanceId: "fixture",
          driver: "antigravity",
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-01-01T00:00:00.000Z",
          models: [],
          slashCommands: [
            { name: "compact" },
            { name: "old" },
            { name: "outside" },
            { name: "beta" },
          ],
          skills: [
            { name: "old", path: "/old/SKILL.md", scope: "user", enabled: true },
            { name: "outside", path: "/outside/SKILL.md", scope: "user", enabled: true },
            { name: "beta", path: "/beta/SKILL.md", scope: "user", enabled: true },
          ],
        });
        const menu = yield* Effect.gen(function* () {
          return yield* antigravitySkillSetSnapshot({
            service: yield* SkillSets.SkillSets,
            instanceId: "instance",
            profileDirectory: profile,
            userHome,
            cwd,
            snapshot: () => Effect.succeed(baseline),
          });
        }).pipe(Effect.provide(service));
        expect(menu.skills.map((skill) => skill.name)).toEqual([
          "alpha",
          "plugin-skill",
          "project-skill",
          "secondary",
        ]);
        expect(menu.slashCommands.map((command) => command.name)).toEqual([
          "compact",
          "alpha",
          "plugin-skill",
          "project-skill",
          "secondary",
        ]);
        expect(yield* fs.readFileString(path.join(profile, "config", "skills.json"))).toContain(
          "outside",
        );
      }),
  );
});
import {
  buildAntigravityAcpSpawnInput,
  type AntigravityProfile,
} from "../../provider/antigravityAuthSupport.ts";
import { applyAntigravitySkillSetProfile } from "./antigravity.ts";

it.layer(NodeServices.layer)("Antigravity spawn fallback", (it) => {
  it.effect(
    "keeps spawn arguments and environment byte-for-byte when the switch is off or building fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const profile: AntigravityProfile = {
          platform: "win32",
          geminiHome: path.join(root, "profile"),
          acpDirectory: path.join(root, "profile", "antigravity-acp"),
          tokenPath: path.join(root, "profile", "antigravity-acp", "acp_token.json"),
          tempDirectory: path.join(root, "tmp"),
          browserCommand: "fixture-browser",
        };
        const auth = {
          authMethod: "gemini-api-key" as const,
          apiKey: "fixture-key",
          gcpProject: "",
          gcpLocation: "",
        };
        const installation = {
          executablePath: "fixture-agy.exe",
          source: "custom" as const,
          version: "1.5.13",
        };
        const input = {
          installation,
          profile,
          cwd: root,
          baseEnv: {
            PATH: "fixture-path",
            HOME: "fixture-home",
            USERPROFILE: "fixture-user",
            CUSTOM: "retained",
          },
          auth,
        };
        const baseline = buildAntigravityAcpSpawnInput(input);
        for (const enabled of [false, true]) {
          const warnings: string[] = [];
          const service = Layer.mock(SkillSets.SkillSets)({
            resolveHome: (driver, instance, thread) =>
              Effect.promise(() =>
                resolveHome(
                  {
                    stateDir: root,
                    settings: {
                      skillSetsEnabled: enabled,
                      defaultSkillSetId: "alpha",
                      skillSets: {
                        alpha: {
                          name: "Alpha",
                          enabled: true,
                          autoSync: false,
                          source: { kind: "local", path: root },
                          disabledSkills: [],
                        },
                      },
                    },
                    statuses: [
                      {
                        id: "alpha",
                        state: "local",
                        commit: null,
                        commitDate: null,
                        lastChecked: null,
                        error: null,
                        skills: [
                          {
                            name: "missing",
                            description: "fixture",
                            targetPath: path.join(root, "missing"),
                            commandOnly: false,
                          },
                        ],
                      },
                    ],
                    warn: (message) => warnings.push(message),
                  },
                  driver,
                  instance,
                  thread,
                ),
              ),
          });
          const applied = yield* Effect.gen(function* () {
            return yield* applyAntigravitySkillSetProfile(
              yield* SkillSets.SkillSets,
              "fixture",
              profile,
              { skillSetId: "alpha" },
            );
          }).pipe(Effect.provide(service));
          expect(applied).toBe(profile);
          expect(buildAntigravityAcpSpawnInput({ ...input, profile: applied })).toEqual(baseline);
          expect(warnings.length).toBe(enabled ? 1 : 0);
          if (!enabled) expect(yield* fs.exists(path.join(root, "skill-sets"))).toBe(false);
        }
      }),
  );
});

import { makeAntigravitySkillSetIntegration } from "./antigravity.ts";
import { makeSessionInputIdentities, withSessionInputIdentity } from "./sessionIdentity.ts";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

it.layer(NodeServices.layer)("Antigravity next-message identity", (it) => {
  it.effect(
    "reopens only when the effective set changes and preserves the native history reference",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        let enabled = true;
        const service = Layer.mock(SkillSets.SkillSets)({
          resolveHome: (_driver, _instance, thread) =>
            Effect.succeed(
              enabled
                ? {
                    homePath: path.join(root, thread.skillSetId ?? "alpha"),
                    skillsDir: path.join(root, "skills"),
                    skills: [],
                  }
                : undefined,
            ),
        });
        const integration = yield* makeAntigravitySkillSetIntegration(
          "fixture",
          path.join(root, "profile"),
          path.join(root, "user"),
        ).pipe(Effect.provide(service));
        const input: ProviderAdapter.ProviderAdapterV2OpenSessionInput = {
          threadId: ThreadId.make("thread"),
          providerSessionId: ProviderSessionId.make("session"),
          modelSelection: { instanceId: ProviderInstanceId.make("instance"), model: "fixture" },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: root,
          }),
        };
        const manager = makeSessionInputIdentities();
        const nativeHistory = { id: "native-history", messages: ["earlier message"] };
        const runtime = withSessionInputIdentity(
          { nativeHistory },
          integration.sessionInputIdentity,
        );
        yield* manager.remember(runtime, input);
        expect(yield* manager.changed(runtime, input)).toBe(false);
        expect(yield* manager.changed(runtime, { ...input, skillSetId: "alpha" })).toBe(false);
        expect(yield* manager.changed(runtime, { ...input, skillSetId: "beta" })).toBe(true);
        const resumed = withSessionInputIdentity(
          { nativeHistory },
          integration.sessionInputIdentity,
        );
        yield* manager.remember(resumed, { ...input, skillSetId: "beta" });
        expect(yield* manager.changed(resumed, { ...input, skillSetId: "beta" })).toBe(false);
        expect(resumed.nativeHistory).toBe(runtime.nativeHistory);
        enabled = false;
        expect(yield* manager.changed(resumed, { ...input, skillSetId: "beta" })).toBe(true);
        yield* manager.remember(resumed, input);
        expect(yield* manager.changed(resumed, { ...input, skillSetId: "another" })).toBe(false);
      }),
  );
});
