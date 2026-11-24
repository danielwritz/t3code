import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettings } from "@t3tools/contracts";
import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { loadSkillSetSettings, saveSkillSetSettings } from "./state.ts";
import { makeThreadState } from "./threadState.ts";
const decodeSettings = Schema.decodeEffect(ServerSettings);
const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(ServerSettings));

const layer = Sqlite.layerConfig.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "skill-state-migration-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "imports legacy settings and thread picks once without deleting or later reimporting them",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const settings = yield* decodeSettings({
        skillSetsEnabled: true,
        defaultSkillSetId: "legacy",
        skillSetSyncIntervalMinutes: 7,
        skillSets: {
          legacy: {
            name: "Legacy",
            source: { kind: "local", path: "/example" },
            enabled: true,
            autoSync: false,
            disabledSkills: ["hidden"],
          },
        },
      });
      const legacy = yield* encodeSettings(settings);
      yield* fs.writeFileString(config.settingsPath, legacy);
      const imported = yield* loadSkillSetSettings(config.settingsPath, settings);
      expect(imported.skillSetSyncIntervalMinutes).toBe(7);
      expect(imported.skillSets.legacy?.disabledSkills).toEqual(["hidden"]);
      expect(yield* fs.readFileString(config.settingsPath)).toBe(legacy);
      yield* saveSkillSetSettings(
        config.settingsPath,
        { ...settings, skillSetsEnabled: false, defaultSkillSetId: null, skillSets: {} },
        legacy,
      );
      const second = yield* loadSkillSetSettings(config.settingsPath, settings);
      expect(second.skillSetsEnabled).toBe(false);
      expect(second.defaultSkillSetId).toBeNull();
      expect(second.skillSets).toEqual({});
      expect(yield* fs.readFileString(config.settingsPath)).toBe(legacy);

      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES ('legacy', 'project', 'Legacy', 'codex', 'codex', 'full-access', 'default', '2026-01-01', '2026-01-01', '{"skillSetId":"legacy"}')`;
      yield* makeThreadState(sql, true);
      const first = yield* fs.readFileString(config.stateDir + "/skill-sets/threads.json");
      expect(JSON.parse(first).legacy).toEqual([{ eventId: null, pick: "legacy" }]);
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = 'legacy'`;
      expect(JSON.parse(rows[0]!.payload_json).skillSetId).toBe("legacy");
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{"skillSetId":"stale"}' WHERE thread_id = 'legacy'`;
      yield* makeThreadState(sql, true);
      expect(yield* fs.readFileString(config.stateDir + "/skill-sets/threads.json")).toBe(first);
    }).pipe(Effect.provide(layer)),
);
