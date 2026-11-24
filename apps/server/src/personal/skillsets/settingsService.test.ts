import * as Queue from "effect/Queue";
import { ServerSettings as SettingsSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { writeSideFile } from "./state.ts";
import type { SkillSetStatus } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ServerSettings from "../../serverSettings.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as SkillSets from "./runtime.ts";
const layer = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(Layer.fresh(Sqlite.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "skill-set-settings-" })),
  ),
);
const layerTest = SkillSets.layer.pipe(
  Layer.provideMerge(layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
it.live("reloads and broadcasts an atomic side-file edit after settings startup", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const config = yield* ServerConfig.ServerConfig;
    yield* settings.start;
    const initial = yield* settings.getSettings;
    const changes = yield* settings.subscribeChanges;
    const next = yield* changes.pipe(
      Stream.filter((value) => value.skillSetSyncIntervalMinutes === 11),
      Stream.runHead,
      Effect.forkScoped,
    );
    yield* Effect.promise(() =>
      writeSideFile(config.stateDir + "/skill-sets/state.json", {
        ...initial,
        skillSetSyncIntervalMinutes: 11,
      }),
    );
    expect(Option.getOrThrow(yield* Fiber.join(next)).skillSetSyncIntervalMinutes).toBe(11);
  }).pipe(
    Effect.provide(
      layer.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    ),
  ),
);
it.effect("persists settings, streams status snapshots and syncs a local linked set", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const source = config.stateDir + "/test-set";
      yield* fs.makeDirectory(source + "/skills/alpha", { recursive: true });
      yield* fs.writeFileString(
        source + "/skills/alpha/SKILL.md",
        "---\nname: alpha\ndescription: Test skill\n---\n",
      );
      yield* settings.updateSettings({
        skillSetsEnabled: true,
        defaultSkillSetId: "alpha",
        skillSetSyncIntervalMinutes: 7,
        skillSets: {
          alpha: {
            name: "Alpha",
            source: { kind: "local", path: source },
            enabled: true,
            autoSync: true,
            disabledSkills: [],
          },
        },
      });
      expect(JSON.parse(yield* fs.readFileString(config.settingsPath)).skillSets).toBeUndefined();
      const saved = JSON.parse(
        yield* fs.readFileString(config.stateDir + "/skill-sets/state.json"),
      );
      expect(saved.skillSetSyncIntervalMinutes).toBe(7);
      expect(saved.skillSets.alpha.name).toBe("Alpha");
      const nightly = Schema.fromJsonString(
        SettingsSchema.mapFields(
          Struct.omit([
            "skillSetsEnabled",
            "defaultSkillSetId",
            "skillSetSyncIntervalMinutes",
            "skillSets",
          ]),
        ),
      );
      const rewritten = yield* Schema.decodeEffect(nightly)(
        yield* fs.readFileString(config.settingsPath),
      ).pipe(Effect.flatMap(Schema.encodeEffect(nightly)));
      yield* fs.writeFileString(config.settingsPath, rewritten);
      yield* Effect.gen(function* () {
        const restarted = yield* ServerSettings.ServerSettingsService;
        const restored = yield* restarted.getSettings;
        expect(restored.skillSetsEnabled).toBe(true);
        expect(restored.defaultSkillSetId).toBe("alpha");
        expect(restored.skillSetSyncIntervalMinutes).toBe(7);
        expect(restored.skillSets.alpha?.name).toBe("Alpha");
      }).pipe(
        Effect.provide(
          Layer.fresh(
            ServerSettings.layer.pipe(
              Layer.provide(ServerSecretStore.layer),
              Layer.provide(ManagedPolicy.layerTest()),
            ),
          ),
        ),
      );
      const handlers = yield* SkillSets.skillSetRpcHandlers;
      yield* handlers["skillSets.sync"]({ id: "alpha" });
      expect((yield* handlers["skillSets.status"]())[0]?.state).toBe("local");
      const providerHome = config.stateDir + "/provider-home";
      yield* fs.makeDirectory(providerHome);
      const resolved = yield* SkillSets.resolveSkillSetHome(
        "codex",
        { instanceId: "first", realHome: providerHome, skillsEntry: "skills" },
        {},
      );
      expect(resolved?.skills.map((skill) => skill.name)).toEqual(["alpha"]);
      const updates = yield* handlers["skillSets.subscribe"]().pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      expect(updates[0]?.[0]?.skills[0]?.name).toBe("alpha");
      const queue = yield* Queue.unbounded<readonly SkillSetStatus[]>();
      yield* handlers["skillSets.subscribe"]().pipe(
        Stream.runForEach((value) => Queue.offer(queue, value)),
        Effect.forkScoped,
      );
      yield* Queue.take(queue);
      yield* handlers["skillSets.sync"]({ id: "alpha" });
      expect((yield* Queue.take(queue))[0]?.state).toBe("syncing");
      expect((yield* Queue.take(queue))[0]?.state).toBe("local");
      yield* settings.updateSettings({ skillSets: { alpha: null } });
      const removed = JSON.parse(yield* fs.readFileString(config.settingsPath));
      expect(removed.skillSets?.alpha).toBeUndefined();
      expect((yield* settings.getSettings).skillSets).toEqual({});
    }),
  ).pipe(Effect.provide(layerTest)),
);
