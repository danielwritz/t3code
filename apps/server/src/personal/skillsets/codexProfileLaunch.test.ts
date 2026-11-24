import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId, type SkillSetConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeCodexSkillSetProbe, makeCodexSkillSets } from "./codex.ts";
import type { CodexSkillInventory } from "./codexIsolation.ts";
import type { CodexConfigEdit } from "./codexProfile.ts";
import { machinePolicyHooksEnvironment } from "./profile.ts";
import { resolveHome, resolveProfile } from "./resolver.ts";
import * as SkillSets from "./runtime.ts";

const decodeSettings = Schema.decodeEffect(CodexSettings);
const hookFile = (tag: string) =>
  JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: tag }] }] } });

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const write = (file: string, text: string) =>
    fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(file, text)));
  const realHome = path.join(root, "instance");
  const realConfig =
    '[mcp_servers.personal]\ncommand = "node"\n\n[plugins."personal@market"]\nenabled = true\n';
  yield* write(path.join(realHome, "config.toml"), realConfig);
  yield* write(path.join(realHome, "AGENTS.md"), "REAL-HOME-MARKER");
  yield* write(path.join(realHome, "hooks.json"), hookFile("real-hook"));
  yield* write(path.join(realHome, "auth.json"), "{}");
  yield* fs.makeDirectory(path.join(realHome, "sessions"));
  const empty = path.join(root, "profile-empty");
  yield* fs.makeDirectory(empty);
  const full = path.join(root, "profile-full");
  yield* write(path.join(full, "AGENTS.md"), "PROFILE-MARKER");
  yield* write(path.join(full, "hooks", "codex.json"), hookFile("profile-hook"));
  yield* write(path.join(full, "plugins.json"), JSON.stringify({ codex: ["alpha@market"] }));
  yield* write(
    path.join(full, "mcp.json"),
    JSON.stringify({ mcpServers: { profileMcp: { command: "node", args: ["mcp.mjs"] } } }),
  );
  const workspace = path.join(root, "repo");
  yield* fs.makeDirectory(workspace);
  const set = (name: string, folder: string): SkillSetConfig => ({
    name,
    source: { kind: "local", path: folder },
    enabled: true,
    autoSync: false,
    disabledSkills: [],
  });
  const ignored = new Map<string, boolean>();
  const warnings: string[] = [];
  const deps = {
    stateDir: path.join(root, "state"),
    settings: {
      skillSetsEnabled: true,
      defaultSkillSetId: "alpha",
      skillSets: { alpha: set("Alpha", empty), beta: set("Beta", full) },
    },
    statuses: (["alpha", "beta"] as const).map((id) => ({
      id,
      state: "local" as const,
      ready: true,
      commit: null,
      commitDate: null,
      lastChecked: null,
      error: null,
      skills: [],
    })),
    warn: (message: string) => warnings.push(message),
    threadIgnoresProject: async (threadId: string) => ignored.get(threadId) ?? null,
  };
  const service = SkillSets.SkillSets.of({
    statuses: Effect.succeed([]),
    changes: Stream.empty,
    syncNow: () => Effect.succeed([]),
    resolveHome: (driver, instance, thread) =>
      Effect.promise(() => resolveHome(deps, driver, instance, thread)),
    resolveProfile: (driver, thread) => Effect.promise(() => resolveProfile(deps, driver, thread)),
  });
  const writes: Array<{ filePath: string; edits: readonly CodexConfigEdit[] }> = [];
  const discoveries: string[] = [];
  const outsideSkill = path.join(root, "os-home", ".agents", "skills", "outside", "SKILL.md");
  yield* write(outsideSkill, "fixture");
  const repoSkill = path.join(workspace, ".agents", "skills", "repo-skill", "SKILL.md");
  const discover = (settings: CodexSettings, _environment: NodeJS.ProcessEnv, cwd: string) =>
    Effect.gen(function* () {
      discoveries.push(cwd);
      const profileHooks = path.join(settings.homePath, "hooks.json");
      const hasHooks = yield* fs.exists(profileHooks);
      return {
        skills: [
          { name: "outside", path: outsideSkill, scope: "user", enabled: true },
          { name: "repo-skill", path: repoSkill, scope: "repo", enabled: true },
        ],
        homeScopedCredentials: false,
        hooks: hasHooks
          ? [
              {
                key: `${profileHooks}:session_start:0:0`,
                source: "user",
                sourcePath: profileHooks,
                currentHash: "sha256:profile-hook",
                command: "profile-hook",
                enabled: true,
                trustStatus: "untrusted",
              },
            ]
          : [],
        hooksState: {},
        project: {
          repoSkillPaths: [repoSkill],
          projectMcpServers: ["repo-mcp"],
          projectHookKeys: ["repo-hook-key"],
        },
      } satisfies CodexSkillInventory;
    }).pipe(Effect.orDie);
  // Stands in for Codex's own writer: marks the copy so a revert to the raw bytes would show.
  const writeConfig = (
    _settings: CodexSettings,
    _environment: NodeJS.ProcessEnv,
    _cwd: string,
    filePath: string,
    edits: readonly CodexConfigEdit[],
  ) =>
    Effect.gen(function* () {
      writes.push({ filePath, edits });
      yield* fs.writeFileString(
        filePath,
        `# generated ${writes.length}\n${JSON.stringify(edits)}\n`,
      );
    }).pipe(Effect.orDie);
  const sets = yield* makeCodexSkillSets(
    ProviderInstanceId.make("codex-profile-fixture"),
    {},
    discover,
    writeConfig,
  ).pipe(Effect.provideService(SkillSets.SkillSets, service));
  const settings = yield* decodeSettings({ homePath: realHome });
  const thread = (skillSetId: string, threadId = "thread-one") => ({
    skillSetId,
    threadId,
    runtimePolicy: { cwd: workspace },
  });
  return {
    fs,
    path,
    root,
    realHome,
    realConfig,
    sets,
    settings,
    thread,
    writes,
    discoveries,
    ignored,
    warnings,
    outsideSkill,
    service,
  };
});

const edit = (edits: readonly CodexConfigEdit[], keyPath: string) =>
  edits.find((entry) => entry.keyPath === keyPath)?.value;

describe("Codex agent profile launch", () => {
  it.effect("an empty profile gets a stock home, a generated config and no hooks", () =>
    Effect.gen(function* () {
      const {
        fs,
        path,
        realHome,
        realConfig,
        sets,
        settings,
        thread,
        writes,
        warnings,
        outsideSkill,
      } = yield* fixture;
      const launch = yield* sets.launch(settings, thread("alpha"));
      const home = launch.settings.homePath;
      expect(home).not.toBe(realHome);
      expect(yield* fs.exists(path.join(home, "AGENTS.md"))).toBe(false);
      expect(yield* fs.exists(path.join(home, "hooks.json"))).toBe(false);
      expect(writes).toHaveLength(1);
      expect(writes[0]!.filePath).toBe(path.join(home, "config.toml"));
      for (const key of ["mcp_servers", "plugins", "hooks", "notify"])
        expect(edit(writes[0]!.edits, key)).toBeNull();
      expect(edit(writes[0]!.edits, "skills.config")).toEqual([
        { path: yield* fs.realPath(outsideSkill), enabled: false },
      ]);
      // The disable list lives in the file: the launch carries no -c at all.
      expect(launch.settings.launchArgs).toBe("--disable hooks");
      expect(launch.environment).toMatchObject(machinePolicyHooksEnvironment(launch.profile!));
      expect(launch.identity).toContain(launch.profile!.contentHash);
      expect(yield* fs.readFileString(path.join(realHome, "config.toml"))).toBe(realConfig);
      expect(yield* fs.readFileString(path.join(realHome, "AGENTS.md"))).toBe("REAL-HOME-MARKER");

      // Rebuilding keeps the generated copy: no second write, no session-change warning.
      const again = yield* sets.launch(settings, thread("alpha"));
      expect(again.settings.homePath).toBe(home);
      expect(writes).toHaveLength(1);
      expect(yield* fs.readFileString(path.join(home, "config.toml"))).toMatch(/^# generated 1/);
      expect(warnings.filter((message) => message.includes("changed during a session"))).toEqual(
        [],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a full profile loads exactly its instructions, hooks, plugins and MCP servers", () =>
    Effect.gen(function* () {
      const { fs, path, sets, settings, thread, writes } = yield* fixture;
      const launch = yield* sets.launch(settings, thread("beta"));
      const home = launch.settings.homePath;
      expect(yield* fs.readFileString(path.join(home, "AGENTS.md"))).toBe("PROFILE-MARKER");
      expect(JSON.parse(yield* fs.readFileString(path.join(home, "hooks.json")))).toEqual(
        JSON.parse(hookFile("profile-hook")),
      );
      const edits = writes.at(-1)!.edits;
      expect(edit(edits, "mcp_servers")).toEqual({
        profileMcp: { command: "node", args: ["mcp.mjs"] },
      });
      expect(edit(edits, "plugins")).toEqual({ "alpha@market": { enabled: true } });
      expect(edit(edits, "hooks")).toEqual({
        state: {
          [`${path.join(home, "hooks.json")}:session_start:0:0`]: {
            trusted_hash: "sha256:profile-hook",
          },
        },
      });
      expect(launch.settings.launchArgs).not.toContain("--disable");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "ignore-project travels per thread, changes the session identity, and hides repo skills from menus",
    () =>
      Effect.gen(function* () {
        const { sets, settings, thread, ignored, service, root, path } = yield* fixture;
        const launch = yield* sets.launch(settings, thread("alpha"));
        expect(yield* launch.threadConfig("thread-one")).toEqual({});
        ignored.set("thread-one", true);
        const config = yield* launch.threadConfig("thread-one");
        expect(config).toMatchObject({
          project_doc_max_bytes: 0,
          "mcp_servers.repo-mcp.enabled": false,
          hooks: { state: { "repo-hook-key": { enabled: false } } },
        });
        expect(yield* launch.threadConfig("thread-two")).toEqual({});
        const flipped = yield* sets.launch(settings, thread("alpha"));
        expect(flipped.identity).not.toBe(launch.identity);
        expect(launch.settings.launchArgs).not.toContain("untrusted");
        expect(flipped.settings.launchArgs).toContain("projects=");
        expect(flipped.settings.launchArgs).toContain("untrusted");
        expect(flipped.settings.homePath).toBe(launch.settings.homePath);

        const probe = yield* makeCodexSkillSetProbe(
          ProviderInstanceId.make("codex-profile-fixture"),
          () =>
            Effect.succeed([
              { name: "repo-skill", scope: "repo" },
              { name: "system-skill", scope: "system" },
            ]),
        ).pipe(
          Effect.provideService(SkillSets.SkillSets, service),
          // Menus reuse the generated home; a real Codex must never start in this test.
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die("no Codex in this test")),
          ),
        );
        const skills = yield* probe({
          binaryPath: "codex",
          homePath: path.join(root, "instance"),
          cwd: path.join(root, "repo"),
          thread: { skillSetId: "alpha", threadId: "thread-one" },
        });
        expect(skills.map((skill) => skill.name)).toEqual(["system-skill"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
