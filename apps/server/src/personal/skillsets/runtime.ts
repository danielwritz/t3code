import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import { AgentProfileError, type SkillSetStatus } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { findSkillSetLogo } from "./logo.ts";
import { SkillSetSync } from "./sync.ts";
import { defaultInventoryPaths, publicInventory, readMachineInventory } from "./inventory.ts";
import type { ResolvedAgentProfile } from "./profile.ts";
import { makeAgentProfileService, type AgentProfileService } from "./profileService.ts";
import { ThreadProfileOptions, threadOptionsPath } from "./profileState.ts";
import {
  HOOK_SWITCH_TOKEN_ENV,
  HookSwitchStore,
  hookSwitchesPath,
  type HookSwitchSession,
} from "./hookSwitches.ts";
import {
  resolveHome,
  resolveProfile,
  type SkillSetInstance,
  type SkillSetThread,
  type ResolvedSkillSetHome,
} from "./resolver.ts";

export class SkillSets extends Context.Service<
  SkillSets,
  {
    readonly statuses: Effect.Effect<readonly SkillSetStatus[]>;
    readonly syncNow: (id: string) => Effect.Effect<readonly SkillSetStatus[]>;
    readonly changes: Stream.Stream<readonly SkillSetStatus[]>;
    readonly resolveHome: (
      driver: string,
      instance: SkillSetInstance,
      thread: SkillSetThread,
    ) => Effect.Effect<ResolvedSkillSetHome | undefined>;
    /** The thread's agent profile for one driver, without building a home. */
    readonly resolveProfile?: (
      driver: string,
      thread: SkillSetThread,
    ) => Effect.Effect<ResolvedAgentProfile | undefined>;
    readonly profiles?: AgentProfileService;
    readonly inventory?: () => ReturnType<typeof readMachineInventory>;
    readonly hookSwitches?: HookSwitchStore;
  }
>()("t3/personal/skillsets/runtime/SkillSets") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const service = yield* ServerSettings.ServerSettingsService;
  let settings = yield* service.getSettings;
  const sync = new SkillSetSync(config.stateDir, () => settings);
  const inventoryPaths = defaultInventoryPaths(
    yield* HostProcess.HomeDirectory,
    yield* HostProcess.Platform,
    yield* HostProcess.Environment,
  );
  const inventory = () => readMachineInventory(inventoryPaths);
  const threadOptions = new ThreadProfileOptions(threadOptionsPath(config.settingsPath));
  const hookSwitches = new HookSwitchStore(hookSwitchesPath(config.settingsPath));
  yield* Effect.promise(() => hookSwitches.pruneStale()).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not prune hook switches", cause)),
  );
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const profiles = makeAgentProfileService({
    stateDir: config.stateDir,
    skillSets: () => runPromise(service.getSettings.pipe(Effect.map((next) => next.skillSets))),
    saveSkillSet: (id, next) =>
      runPromise(
        service.updateSettings({ skillSets: { [id]: next } }).pipe(
          Effect.tap((updated) =>
            Effect.sync(() => {
              settings = updated;
            }),
          ),
          Effect.asVoid,
        ),
      ),
    statuses: () => sync.statuses(),
    syncNow: (id) => sync.syncNow(id),
    inventory,
    threadOptions,
  });
  const resolverDeps = (warn: (message: string) => void) => ({
    stateDir: config.stateDir,
    settings,
    statuses: sync.statuses(),
    warn,
    inventory,
    threadIgnoresProject: (threadId: string) => threadOptions.ignoreProject(threadId),
  });
  const refreshSettings = service.getSettings.pipe(
    Effect.tap((next) =>
      Effect.sync(() => {
        settings = next;
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not read skill-set settings", cause).pipe(Effect.as(settings)),
    ),
  );
  yield* refreshSettings.pipe(
    Effect.andThen(Effect.promise(() => sync.tick())),
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.forkScoped,
  );
  return SkillSets.of({
    statuses: Effect.sync(() => sync.statuses()),
    syncNow: Effect.fn("SkillSets.syncNow")(function* (id: string) {
      yield* refreshSettings;
      yield* Effect.promise(() => sync.syncNow(id));
      return sync.statuses();
    }),
    changes: Stream.callback<readonly SkillSetStatus[]>((queue) =>
      Effect.gen(function* () {
        const unsubscribe = sync.subscribe((statuses) => {
          Queue.offerUnsafe(queue, statuses);
        });
        Queue.offerUnsafe(queue, sync.statuses());
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      }),
    ),
    resolveHome: Effect.fn("SkillSets.resolveHome")(function* (
      driver: string,
      instance: SkillSetInstance,
      thread: SkillSetThread,
    ) {
      yield* refreshSettings;
      const warnings: string[] = [];
      const result = yield* Effect.promise(() =>
        resolveHome(
          resolverDeps((message) => warnings.push(message)),
          driver,
          instance,
          thread,
        ),
      );
      for (const warning of warnings) yield* Effect.logWarning(warning);
      return result;
    }),
    resolveProfile: Effect.fn("SkillSets.resolveProfile")(function* (
      driver: string,
      thread: SkillSetThread,
    ) {
      yield* refreshSettings;
      const warnings: string[] = [];
      const result = yield* Effect.promise(() =>
        resolveProfile(
          resolverDeps((message) => warnings.push(message)),
          driver,
          thread,
        ),
      );
      for (const warning of warnings) yield* Effect.logWarning(warning);
      return result;
    }),
    profiles,
    inventory,
    hookSwitches,
  });
});
export const layer = Layer.effect(SkillSets, make);
export const resolveSkillSetHome = Effect.fn("resolveSkillSetHome")(function* (
  driver: string,
  instance: SkillSetInstance,
  thread: SkillSetThread,
) {
  return yield* (yield* SkillSets).resolveHome(driver, instance, thread);
});
/** The thread's agent profile for one driver: what each provider builder applies. */
/**
 * Starts the machine-policy hook switch for one provider session (lead decision 19). Merge `env`
 * into the provider process environment, call `setPid` once the process runs, and `close` when the
 * session ends. With nothing switched off, the token variable is blank and no entry is written.
 */
export const openHookSwitchSession = Effect.fn("openHookSwitchSession")(function* (
  profile: Pick<ResolvedAgentProfile, "machinePolicyHooksOff">,
  pid?: number,
) {
  const store = (yield* SkillSets).hookSwitches;
  if (!store)
    return {
      env: { [HOOK_SWITCH_TOKEN_ENV]: "" },
      setPid: async () => {},
      close: async () => {},
    } satisfies HookSwitchSession;
  return yield* Effect.promise(() => store.open(profile, pid));
});
export const resolveAgentProfile = Effect.fn("resolveAgentProfile")(function* (
  driver: string,
  thread: SkillSetThread,
) {
  const service = yield* SkillSets;
  return service.resolveProfile ? yield* service.resolveProfile(driver, thread) : undefined;
});
const profileCall = <A>(run: (() => Promise<A>) | undefined) =>
  Effect.tryPromise({
    try: () => (run ? run() : Promise.reject(new Error("Agent profiles are unavailable"))),
    catch: (error) =>
      new AgentProfileError({ message: error instanceof Error ? error.message : String(error) }),
  });
export const skillSetRpcHandlers = Effect.gen(function* () {
  const service = yield* SkillSets;
  const profiles = service.profiles;
  const inventory = service.inventory;
  return {
    "skillSets.status": () => service.statuses,
    "skillSets.sync": ({ id }: { readonly id: string }) => service.syncNow(id),
    "skillSets.subscribe": () => service.changes,
    "agentProfiles.list": () => profileCall(profiles && (() => profiles.list())),
    "agentProfiles.inventory": () =>
      profileCall(inventory && (async () => publicInventory(await inventory()))),
    "agentProfiles.setItemEnabled": (input: {
      readonly profileId: string;
      readonly itemId: string;
      readonly enabled: boolean;
    }) =>
      profileCall(
        profiles && (() => profiles.setItemEnabled(input.profileId, input.itemId, input.enabled)),
      ),
    "agentProfiles.setIgnoreProject": (input: {
      readonly profileId: string;
      readonly ignore: boolean;
    }) => profileCall(profiles && (() => profiles.setIgnoreProject(input.profileId, input.ignore))),
    "agentProfiles.threadOptions": (input: { readonly threadId: string }) =>
      profileCall(profiles && (() => profiles.threadOptions(input.threadId))),
    "agentProfiles.setThreadIgnoreProject": (input: {
      readonly threadId: string;
      readonly ignore: boolean | null;
    }) =>
      profileCall(
        profiles && (() => profiles.setThreadIgnoreProject(input.threadId, input.ignore)),
      ),
    "agentProfiles.createFromReferences": (input: {
      readonly id: string;
      readonly name: string;
      readonly references: readonly string[];
    }) =>
      profileCall(
        profiles && (() => profiles.createFromReferences(input.id, input.name, input.references)),
      ),
  };
});

export const resolveSkillSetLogo = Effect.fn("SkillSets.resolveLogo")(function* (id: string) {
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (!settings) return undefined;
  const config = settings.skillSets[id];
  if (!config || (config.logo && config.logo.kind !== "repo-image")) return undefined;
  const state = yield* ServerConfig.ServerConfig;
  const checkout = new SkillSetSync(state.stateDir, () => settings).checkout(id, config);
  return yield* Effect.promise(() =>
    findSkillSetLogo(
      checkout,
      config.logo?.kind === "repo-image" ? config.logo.path : undefined,
    ).catch(() => undefined),
  );
});
