import { CodexSettings, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SkillSets from "./runtime.ts";
import type { SkillSetThread } from "./resolver.ts";
import { withSessionInputIdentity } from "./sessionIdentity.ts";
import {
  codexSkillRules,
  discoverCodexSkillInventory,
  writeCodexConfig,
  type CodexSkillInventory,
} from "./codexIsolation.ts";
import {
  codexIgnoreProjectConfig,
  codexOwnedEntries,
  codexProfileConfigEdits,
  codexProfileDisablesHooks,
  codexUntrustedProjectsArg,
  type CodexConfigEdit,
  type CodexProjectInventory,
} from "./codexProfile.ts";
import { acceptOwnedEntries } from "./home.ts";
import { machinePolicyHooksEnvironment, type ResolvedAgentProfile } from "./profile.ts";
import { resolveCodexLaunchArgs } from "../../provider/codexLaunchArgs.ts";
import { KNOWN_SHARED_DIRECTORIES } from "../../provider/Drivers/CodexHomeLayout.ts";
import * as ServerSettings from "../../serverSettings.ts";

const launchIdentity = (home: string, args: string, cwd: string, profile?: ResolvedAgentProfile) =>
  JSON.stringify([home, args, cwd, profile?.contentHash ?? null]);
const decodeSettings = Schema.decodeEffect(CodexSettings);
type ThreadConfig = Readonly<Record<string, Schema.Json>>;
const noThreadConfig = (_threadId: string | null, _cwd?: string | null) =>
  Effect.succeed<ThreadConfig>({});

/** The generated `config.toml` per built home, so a rebuild writes it back instead of the raw copy. */
const generatedConfigs = new Map<
  string,
  { readonly real: string | null; readonly edits: string; readonly contents: string }
>();
const homeLocks = new Map<string, Semaphore.Semaphore>();
const homeLock = (key: string) => {
  let lock = homeLocks.get(key);
  if (!lock) homeLocks.set(key, (lock = Semaphore.makeUnsafe(1)));
  return lock;
};

const textKey = (...parts: readonly unknown[]) => JSON.stringify(parts);

/** Codex app-server calls; tests replace them. Failures are defects the launch logs and survives. */
type Discover = (
  settings: CodexSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) => Effect.Effect<CodexSkillInventory>;
type WriteConfig = (
  settings: CodexSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  filePath: string,
  edits: readonly CodexConfigEdit[],
) => Effect.Effect<void>;

export const makeCodexSkillSets = Effect.fn("SkillSets.makeCodexLaunch")(function* (
  instanceId: ProviderInstanceId,
  environment: NodeJS.ProcessEnv = {},
  discover?: Discover,
  writeConfig?: WriteConfig,
) {
  const service = yield* Effect.serviceOption(SkillSets.SkillSets);
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* HostProcess.WorkingDirectory;
  const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
  const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const withCodex = <A, X>(
    effect: Effect.Effect<
      A,
      X,
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
    >,
  ): Effect.Effect<A> =>
    Option.isSome(spawner)
      ? effect.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner.value),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.scoped,
          Effect.timeout("20 seconds"),
          Effect.orDie,
        )
      : Effect.die("Codex app-server unavailable");
  const runDiscovery: Discover =
    discover ??
    ((settings, env, workspace) =>
      withCodex(discoverCodexSkillInventory(settings, env, workspace)));
  const runConfigWrite: WriteConfig =
    writeConfig ??
    ((settings, env, workspace, filePath, edits) =>
      withCodex(writeCodexConfig(settings, env, workspace, filePath, edits)));
  const selection = Effect.fn("SkillSets.codexSelection")(function* (thread: SkillSetThread) {
    const settings = Option.isSome(settingsService)
      ? yield* settingsService.value.getSettings.pipe(Effect.option)
      : Option.none();
    const id =
      Option.isNone(service) || (Option.isSome(settings) && !settings.value.skillSetsEnabled)
        ? undefined
        : (thread.skillSetId ??
          (Option.isSome(settings) ? settings.value.defaultSkillSetId : undefined) ??
          undefined);
    return {
      id,
      name:
        id === undefined
          ? "upstream"
          : Option.isSome(settings)
            ? (settings.value.skillSets[id]?.name ?? id)
            : id,
    };
  });
  const launch = Effect.fn("SkillSets.codexLaunch")(function* (
    settings: CodexSettings,
    thread: SkillSetThread & { readonly runtimePolicy?: { readonly cwd: string | null } },
    workspace = thread.runtimePolicy?.cwd ?? cwd,
    launchEnvironment = environment,
  ) {
    const environment = launchEnvironment;
    const upstream = {
      settings,
      environment,
      identity: undefined as string | undefined,
      skillSetId: undefined as string | undefined,
      profile: undefined as ResolvedAgentProfile | undefined,
      threadConfig: noThreadConfig,
    };
    if (Option.isNone(service)) return upstream;
    const realHome = settings.homePath || environment.CODEX_HOME || path.join(home, ".codex");
    const realConfig = yield* fs
      .readFileString(path.join(realHome, "config.toml"))
      .pipe(Effect.orElseSucceed(() => null));
    // One built home per working directory: the skill disable list depends on the project's aliases.
    const homeKey = textKey(instanceId, realHome, path.resolve(workspace));
    const generatedKey = (profileId: string) => textKey(homeKey, profileId);
    const instance = {
      instanceId: homeKey,
      realHome,
      skillsEntry: "skills",
      privateEntries: ["models_cache.json"],
      owned: (profile: ResolvedAgentProfile) => {
        const generated = generatedConfigs.get(generatedKey(profile.profileId));
        return codexOwnedEntries(
          profile,
          generated && generated.real === realConfig ? generated.contents : realConfig,
        );
      },
    };
    const resolve = service.value
      .resolveHome("codex", instance, thread)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not resolve Codex skill-set home", cause).pipe(
            Effect.as(undefined),
          ),
        ),
      );
    return yield* Effect.gen(function* () {
      let resolved = yield* resolve;
      if (!resolved) return upstream;
      // Match the existing shadow-home layout so new archives and writer locks stay shared across sets.
      let addedRuntimeDirectory = false;
      for (const entry of KNOWN_SHARED_DIRECTORIES) {
        if (entry === "skills" || (yield* fs.exists(path.join(realHome, entry)))) continue;
        yield* fs.makeDirectory(path.join(realHome, entry));
        addedRuntimeDirectory = true;
      }
      if (addedRuntimeDirectory) resolved = yield* resolve;
      if (!resolved) return upstream;
      const built = resolved;
      // Preserve the instance's private login identity. Codex resolves auth symlinks before atomic replacement.
      for (const entry of ["auth.json", "auth.lock"]) {
        const destination = path.join(built.homePath, entry);
        const exists = yield* fs.readLink(destination).pipe(Effect.option);
        if (
          Option.isSome(exists) &&
          path.resolve(path.dirname(destination), exists.value) === path.join(realHome, entry)
        )
          continue;
        if (Option.isSome(exists)) yield* fs.remove(destination);
        yield* fs.symlink(path.join(realHome, entry), destination);
      }
      const profile = built.profile;
      const launchEnvironment: NodeJS.ProcessEnv = {
        ...environment,
        CODEX_SQLITE_HOME: environment.CODEX_SQLITE_HOME ?? realHome,
        T3CODE_CODEX_LAUNCH_ARGS: undefined,
        ...(profile ? machinePolicyHooksEnvironment(profile) : {}),
      };
      let launchSettings = {
        ...settings,
        homePath: built.homePath,
        launchArgs: resolveCodexLaunchArgs(settings.launchArgs, environment),
      };
      const inventory = yield* runDiscovery(launchSettings, launchEnvironment, workspace).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Codex user-skill isolation discovery failed; external user skills may remain visible",
            cause,
          ).pipe(Effect.as(undefined)),
        ),
      );
      if (inventory?.homeScopedCredentials) {
        yield* Effect.logWarning(
          "Codex keyring credentials are scoped to the instance home; using that home to preserve login",
        );
        return upstream;
      }
      if (profile) {
        const generated = generatedConfigs.get(generatedKey(profile.profileId));
        const current = generated?.real === realConfig ? generated : undefined;
        if (!inventory) {
          // Without discovery the copy may still be the raw personal config; never run on that.
          if (!current) return upstream;
        } else {
          const skillRules = yield* codexSkillRules(
            inventory.skills,
            built.skills,
            inventory.preservedPaths,
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
          const edits = codexProfileConfigEdits({
            profile,
            realHome,
            homePath: built.homePath,
            skillRules,
            hooks: inventory.hooks ?? [],
            hooksState: inventory.hooksState,
            userPlugins: inventory.userPlugins,
          });
          const editsKey = textKey(edits);
          if (current?.edits !== editsKey) {
            const configPath = path.join(built.homePath, "config.toml");
            yield* runConfigWrite(launchSettings, launchEnvironment, workspace, configPath, edits);
            yield* Effect.promise(() => acceptOwnedEntries(built.homePath, ["config.toml"]));
            generatedConfigs.set(generatedKey(profile.profileId), {
              real: realConfig,
              edits: editsKey,
              contents: yield* fs.readFileString(configPath),
            });
          }
          const flags = [
            codexProfileDisablesHooks(profile, inventory.hooks ?? []) ? "--disable hooks" : "",
            // The session owner's switch is in the process identity, so the whole process can follow it.
            profile.ignoreProjectInstructions
              ? codexUntrustedProjectsArg(inventory.projectDirectories ?? [workspace])
              : "",
          ].filter(Boolean);
          if (flags.length)
            launchSettings = {
              ...launchSettings,
              launchArgs: [launchSettings.launchArgs, ...flags].join(" ").trim(),
            };
        }
      }
      const projects = new Map<string, CodexProjectInventory>();
      if (inventory?.project) projects.set(path.resolve(workspace), inventory.project);
      const threadConfig = Effect.fn("SkillSets.codexThreadConfig")(
        function* (threadId: string | null, threadCwd?: string | null) {
          if (!profile) return {};
          const effective =
            threadId === null || !service.value.resolveProfile
              ? profile
              : yield* service.value.resolveProfile("codex", {
                  skillSetId: profile.profileId,
                  threadId,
                });
          if (!effective?.ignoreProjectInstructions) return {};
          const directory = path.resolve(threadCwd ?? workspace);
          let project = projects.get(directory);
          if (!project) {
            project = (yield* runDiscovery(launchSettings, launchEnvironment, directory)).project;
            if (project) projects.set(directory, project);
          }
          return project ? codexIgnoreProjectConfig(project) : { project_doc_max_bytes: 0 };
        },
        (effect) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "Could not apply the Codex ignore-project switch; the repo stays visible",
                cause,
              ).pipe(Effect.as<ThreadConfig>({})),
            ),
          ),
      );
      return {
        settings: launchSettings,
        environment: launchEnvironment,
        identity: launchIdentity(built.homePath, launchSettings.launchArgs, workspace, profile),
        skillSetId: (yield* selection(thread)).id,
        profile,
        threadConfig,
      };
    }).pipe(
      homeLock(homeKey).withPermit,
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Could not prepare Codex skill-set home; using instance home",
          cause,
        ).pipe(Effect.as(upstream)),
      ),
    );
  });
  return {
    launch,
    track: <T extends object>(
      runtime: T,
      settings: CodexSettings,
      environment: NodeJS.ProcessEnv | undefined,
      initial: { readonly identity: string | undefined; readonly skillSetId: string | undefined },
    ) => {
      let firstRead = true;
      return withSessionInputIdentity(
        runtime,
        (thread) => {
          if (firstRead) {
            firstRead = false;
            return Effect.succeed(initial.identity);
          }
          return launch(settings, thread, undefined, environment).pipe(
            Effect.map((next) => next.identity),
          );
        },
        (_owner, attached) =>
          Effect.gen(function* () {
            const requested = yield* selection(attached);
            if (requested.id === initial.skillSetId) return false;
            const owner =
              initial.skillSetId === undefined
                ? { name: "upstream" }
                : yield* selection({ skillSetId: initial.skillSetId });
            yield* Effect.logWarning("Attached Codex thread uses the session owner's skill set", {
              sessionSkillSet: owner.name,
              requestedSkillSet: requested.name,
            });
            return true;
          }),
      );
    },
  };
});

interface ProbeInput {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeCodexSkillSetProbe = Effect.fn("SkillSets.codexProbe")(function* <
  S extends { readonly scope?: string | undefined },
  E,
  R,
>(instanceId: ProviderInstanceId, probe: (input: ProbeInput) => Effect.Effect<readonly S[], E, R>) {
  const sets = yield* makeCodexSkillSets(instanceId);
  return (request: ProbeInput & { readonly thread?: SkillSetThread | undefined }) =>
    Effect.gen(function* () {
      const { thread = {}, ...input } = request;
      const settings = yield* decodeSettings({
        binaryPath: input.binaryPath,
        homePath: input.homePath ?? "",
        launchArgs: input.launchArgs ?? "",
      });
      const launch = yield* sets.launch(settings, thread, input.cwd, input.environment);
      const skills = yield* probe(
        launch.identity === undefined
          ? input
          : {
              ...input,
              homePath: launch.settings.homePath,
              launchArgs: launch.settings.launchArgs,
              environment: launch.environment,
            },
      );
      // The thread itself drops repo skills (codexIgnoreProjectConfig); its menus follow.
      return launch.profile?.ignoreProjectInstructions
        ? skills.filter((skill) => skill.scope !== "repo")
        : skills;
    });
});
