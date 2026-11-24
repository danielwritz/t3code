// @effect-diagnostics nodeBuiltinImport:off -- Thread-local filesystem homes use native junction semantics.
import * as Effect from "effect/Effect";
import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { upsertProviderWorkspaceSnapshot } from "../../provider/ProviderRegistry.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";

/** Thread menus are request-local: never put one thread's pick in the shared cwd cache. */
const refreshSkillSetWorkspaceSnapshot = Effect.fn("refreshSkillSetWorkspaceSnapshot")(function* (
  input: {
    readonly instanceId: ProviderInstanceId;
    readonly cwd: string;
    readonly scanCwd?: string;
    readonly fresh?: boolean;
    readonly threadId?: ThreadId | undefined;
  },
  registry: ProviderRegistry.ProviderRegistry["Service"],
  instances: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  threads: ThreadManagement.ThreadManagementService["Service"],
  settingsService: ServerSettings.ServerSettingsService["Service"],
) {
  if (input.threadId === undefined) return yield* registry.refreshWorkspaceSnapshot(input);
  const scoped = yield* Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    if (!settings.skillSetsEnabled) return undefined;
    const thread = (yield* threads.getThreadRecords(input.threadId!, [])).thread;
    const instance = yield* instances.getInstance(input.instanceId);
    if (!instance?.snapshotForCwd) return undefined;
    const snapshot = yield* instance.snapshotForCwd(input.scanCwd ?? input.cwd, thread);
    const providers = yield* registry.getProviders;
    return providers.map((provider) =>
      provider.instanceId === input.instanceId
        ? upsertProviderWorkspaceSnapshot(provider, input.cwd, snapshot)
        : provider,
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Skill-set menu scan failed; using provider inventory", cause).pipe(
        Effect.as(undefined),
      ),
    ),
  );
  return scoped ?? (yield* registry.refreshWorkspaceSnapshot(input));
});

export const skillSetMenuRefresh = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  return (input: Parameters<typeof refreshSkillSetWorkspaceSnapshot>[0]) =>
    refreshSkillSetWorkspaceSnapshot(input, registry, instances, threads, settings);
});
