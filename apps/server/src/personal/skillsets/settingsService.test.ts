import * as Queue from "effect/Queue";
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
      const saved = JSON.parse(yield* fs.readFileString(config.stateDir + "/skill-sets/state.json"));
      expect(saved.skillSetSyncIntervalMinutes).toBe(7);
      expect(saved.skillSets.alpha.name).toBe("Alpha");
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
