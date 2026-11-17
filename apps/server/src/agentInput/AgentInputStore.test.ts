import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentInputStore from "./AgentInputStore.ts";

const live = ThreadId.make("thread-live");
const deleted = ThreadId.make("thread-deleted");

const record = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const store = yield* AgentInputStore.AgentInputStore;
    yield* store.record({ threadId, kind: "host-instructions", origin: "t3", title: "T3", text });
  });

it.layer(
  AgentInputStore.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
)("AgentInputStore", (it) => {
  it.effect("stores each text once and removes deleted threads' rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* AgentInputStore.AgentInputStore;
      yield* record(live, "Shared instructions.");
      yield* record(deleted, "Shared instructions.");
      yield* record(deleted, "Only on the deleted thread.");
      const blobs = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM agent_input_blobs
      `;
      expect(blobs[0]?.count).toBe(2);
      const rows = yield* store.listRecords(live);
      expect(rows.map((row) => [row.kind, row.chars])).toEqual([["host-instructions", 20]]);
      expect(yield* store.readText(rows[0]!.sha256)).toBe("Shared instructions.");

      yield* sql`
        INSERT INTO instruction_profile_applications
          (thread_id, profile_id, profile_name, driver, effects_json, applied_at)
        VALUES (${deleted}, 'p1', 'Lean', 'codex',
          '[{"toggle":"skill","name":"lint","state":"applied","detail":"Hidden."}]',
          '2026-01-01T00:00:00.000Z')
      `;
      expect(yield* store.latestProfileUse(deleted)).toEqual({
        profileId: "p1",
        profileName: "Lean",
        appliedAt: "2026-01-01T00:00:00.000Z",
        effects: [{ toggle: "skill", name: "lint", state: "applied", detail: "Hidden." }],
      });

      for (const [threadId, deletedAt] of [
        [live, null],
        [deleted, "2026-01-02T00:00:00.000Z"],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, deleted_at, payload_json
          ) VALUES (${threadId}, 'project-1', 'Title', 'codex', 'full-access', 'default',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${deletedAt}, '{}')
        `;
      }
      yield* AgentInputStore.purgeDeletedThreadAgentInput();
      expect(yield* store.listRecords(deleted)).toEqual([]);
      expect(yield* store.latestProfileUse(deleted)).toBeUndefined();
      expect(yield* store.listRecords(live)).toHaveLength(1);
    }),
  );
});
