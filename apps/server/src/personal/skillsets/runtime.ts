import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import type { SkillSetStatus } from "@t3tools/contracts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { findSkillSetLogo } from "./logo.ts";
import { SkillSetSync } from "./sync.ts";
import {
  resolveHome,
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
  }
>()("t3/personal/skillsets/runtime/SkillSets") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const service = yield* ServerSettings.ServerSettingsService;
  let settings = yield* service.getSettings;
  const sync = new SkillSetSync(config.stateDir, () => settings);
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
          {
            stateDir: config.stateDir,
            settings,
            statuses: sync.statuses(),
            warn: (message) => warnings.push(message),
          },
          driver,
          instance,
          thread,
        ),
      );
      for (const warning of warnings) yield* Effect.logWarning(warning);
      return result;
    }),
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
export const skillSetRpcHandlers = Effect.gen(function* () {
  const service = yield* SkillSets;
  return {
    "skillSets.status": () => service.statuses,
    "skillSets.sync": ({ id }: { readonly id: string }) => service.syncNow(id),
    "skillSets.subscribe": () => service.changes,
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
