import { CodexSettings, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SkillSets from "./runtime.ts";
import type { SkillSetThread } from "./resolver.ts";
import { withSessionInputIdentity } from "./sessionIdentity.ts";
import {
  codexIsolationOverrides,
  discoverCodexSkillInventory,
  type CodexSkillInventory,
} from "./codexIsolation.ts";
import { resolveCodexLaunchArgs } from "../../provider/codexLaunchArgs.ts";
import { KNOWN_SHARED_DIRECTORIES } from "../../provider/Drivers/CodexHomeLayout.ts";
import * as ServerSettings from "../../serverSettings.ts";

const launchIdentity = (home: string, args: string, cwd: string) =>
  JSON.stringify([home, args, cwd]);
const decodeSettings = Schema.decodeEffect(CodexSettings);

export const makeCodexSkillSets = Effect.fn("SkillSets.makeCodexLaunch")(function* <E = never>(
  instanceId: ProviderInstanceId,
  environment: NodeJS.ProcessEnv = {},
  discover?: (
    settings: CodexSettings,
    environment: NodeJS.ProcessEnv,
    cwd: string,
  ) => Effect.Effect<CodexSkillInventory, E>,
) {
  const service = yield* Effect.serviceOption(SkillSets.SkillSets);
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* HostProcess.WorkingDirectory;
  const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
  const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
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
    };
    if (Option.isNone(service)) return upstream;
    const realHome = settings.homePath || environment.CODEX_HOME || path.join(home, ".codex");
    const instance = {
      instanceId,
      realHome,
      skillsEntry: "skills",
      privateEntries: ["models_cache.json"],
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
    let resolved = yield* resolve;
    if (!resolved) return upstream;
    return yield* Effect.gen(function* () {
      // Match the existing shadow-home layout so new archives and writer locks stay shared across sets.
      let addedRuntimeDirectory = false;
      for (const entry of KNOWN_SHARED_DIRECTORIES) {
        if (entry === "skills" || (yield* fs.exists(path.join(realHome, entry)))) continue;
        yield* fs.makeDirectory(path.join(realHome, entry));
        addedRuntimeDirectory = true;
      }
      if (addedRuntimeDirectory) resolved = yield* resolve;
      if (!resolved) return upstream;
      // Preserve the instance's private login identity. Codex resolves auth symlinks before atomic replacement.
      for (const entry of ["auth.json", "auth.lock"]) {
        const destination = path.join(resolved.homePath, entry);
        const exists = yield* fs.readLink(destination).pipe(Effect.option);
        if (
          Option.isSome(exists) &&
          path.resolve(path.dirname(destination), exists.value) === path.join(realHome, entry)
        )
          continue;
        if (Option.isSome(exists)) yield* fs.remove(destination);
        yield* fs.symlink(path.join(realHome, entry), destination);
      }
      const launchEnvironment = {
        ...environment,
        CODEX_SQLITE_HOME: environment.CODEX_SQLITE_HOME ?? realHome,
        T3CODE_CODEX_LAUNCH_ARGS: undefined,
      };
      let launchSettings = {
        ...settings,
        homePath: resolved.homePath,
        launchArgs: resolveCodexLaunchArgs(settings.launchArgs, environment),
      };
      const inventory = yield* Effect.gen(function* () {
        if (discover) return yield* discover(launchSettings, launchEnvironment, workspace);
        if (Option.isSome(spawner)) {
          return yield* discoverCodexSkillInventory(
            launchSettings,
            launchEnvironment,
            workspace,
          ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner.value),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.scoped,
            Effect.timeout("20 seconds"),
          );
        }
        return yield* Effect.fail("discovery unavailable");
      }).pipe(
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
      if (inventory) {
        const override = yield* codexIsolationOverrides(
          inventory.skills,
          resolved.skills,
          inventory.preservedPaths,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        launchSettings = {
          ...launchSettings,
          launchArgs: `${launchSettings.launchArgs} ${override}`.trim(),
        };
      }
      return {
        settings: launchSettings,
        environment: launchEnvironment,
        identity: launchIdentity(resolved.homePath, launchSettings.launchArgs, workspace),
        skillSetId: (yield* selection(thread)).id,
      };
    }).pipe(
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

export const makeCodexSkillSetProbe = Effect.fn("SkillSets.codexProbe")(function* <A, E, R>(
  instanceId: ProviderInstanceId,
  probe: (input: ProbeInput) => Effect.Effect<A, E, R>,
) {
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
      return yield* probe(
        launch.identity === undefined
          ? input
          : {
              ...input,
              homePath: launch.settings.homePath,
              launchArgs: launch.settings.launchArgs,
              environment: launch.environment,
            },
      );
    });
});
