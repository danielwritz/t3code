import type { ClaudeSettings, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveClaudeHomePath } from "../../provider/Drivers/ClaudeHome.ts";
import { discoverClaudeSkills } from "../../provider/Drivers/ClaudeSkills.ts";
import { probeClaudeWorkspaceSnapshot } from "../../provider/ClaudeProvider.ts";
import type { SkillSetThread } from "./resolver.ts";
import * as SkillSets from "./runtime.ts";
import { linkClaudeGlobalConfig } from "./claudeHome.ts";
import { claudeSkillSetInvocationSettings, claudeSkillSetQueryKey } from "./claudeSettings.ts";

export const makeClaudeSkillSets = Effect.fn("makeClaudeSkillSets")(function* (
  instanceId: string,
  settings: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
) {
  const service = yield* Effect.serviceOption(SkillSets.SkillSets);
  const realHome = yield* resolveClaudeHomePath(settings, environment);
  const userHome = yield* HostProcess.HomeDirectory;
  const secureStorageHome =
    environment.CLAUDE_SECURESTORAGE_CONFIG_DIR ??
    (settings.homePath.trim() || environment.CLAUDE_CONFIG_DIR ? realHome : "");
  const resolve = Effect.fn("ClaudeSkillSets.resolve")(function* (thread: SkillSetThread = {}) {
    if (Option.isNone(service)) return undefined;
    return yield* SkillSets.resolveSkillSetHome(
      "claudeAgent",
      { instanceId, realHome, skillsEntry: "skills" },
      thread,
    ).pipe(
      Effect.provideService(SkillSets.SkillSets, service.value),
      Effect.tap((home) =>
        home && !settings.homePath.trim() && !environment.CLAUDE_CONFIG_DIR
          ? Effect.promise(() => linkClaudeGlobalConfig(home.homePath, userHome))
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not resolve Claude skill set; using provider home", cause).pipe(
          Effect.as(undefined),
        ),
      ),
    );
  });
  const queryEnvironment = Effect.fn("ClaudeSkillSets.queryEnvironment")(function* (
    base: NodeJS.ProcessEnv,
    thread: SkillSetThread,
  ) {
    const home = yield* resolve(thread);
    return home
      ? {
          ...base,
          CLAUDE_CONFIG_DIR: home.homePath,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: secureStorageHome,
        }
      : base;
  });
  const querySettings = <T extends object>(base: NodeJS.ProcessEnv, settings: T | undefined) =>
    claudeSkillSetInvocationSettings(
      settings,
      Boolean(base.CLAUDE_CONFIG_DIR && base.CLAUDE_CONFIG_DIR !== environment.CLAUDE_CONFIG_DIR),
    );
  const queryPolicyKey = Effect.fn("ClaudeSkillSets.queryPolicyKey")(function* (
    base: string,
    thread: SkillSetThread,
  ) {
    const home = yield* resolve(thread);
    return claudeSkillSetQueryKey(base, home);
  });
  const querySettingsInput = <T extends object, U extends object>(
    base: NodeJS.ProcessEnv,
    settings: T | undefined,
    normalize: (settings: T) => U,
  ) => {
    const sdkSettings = querySettings(
      base,
      settings === undefined ? undefined : normalize(settings),
    );
    return sdkSettings === undefined ? {} : { sdkSettings };
  };
  const discover = Effect.fn("ClaudeSkillSets.discover")(function* (
    cwd: string | undefined,
    thread: SkillSetThread = {},
  ) {
    const home = yield* resolve(thread);
    return yield* discoverClaudeSkills(
      home ? { ...settings, homePath: home.homePath } : settings,
      cwd,
      environment,
    );
  });
  const snapshot = Effect.fn("ClaudeSkillSets.snapshot")(function* (
    machineSnapshot: ServerProvider,
    cwd: string,
    thread: SkillSetThread = {},
  ) {
    const home = yield* resolve(thread);
    return yield* probeClaudeWorkspaceSnapshot(
      home ? { ...settings, homePath: home.homePath } : settings,
      machineSnapshot,
      cwd,
      home
        ? {
            ...environment,
            CLAUDE_CONFIG_DIR: home.homePath,
            CLAUDE_SECURESTORAGE_CONFIG_DIR: secureStorageHome,
          }
        : environment,
      home !== undefined,
    );
  });
  return {
    queryEnvironment,
    querySettings,
    querySettingsInput,
    queryPolicyKey,
    discover,
    snapshot,
  };
});
