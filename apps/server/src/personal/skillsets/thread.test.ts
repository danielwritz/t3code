import { applyShellStreamEvent } from "../../../../../packages/client-runtime/src/state/shellReducer.ts";
import { v2ShellSnapshot } from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  OrchestrationV2ThreadShellJson,
  OrchestrationV2AppThreadJson,
  EventId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Struct from "effect/Struct";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ApplicationEvents from "../../persistence/OrchestrationEventStore.ts";
import * as DateTime from "effect/DateTime";
import { layerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { layerFromAdapters } from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { threadShellFromProjection } from "../../orchestration-v2/ProjectionStore.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
const encodeShell = Schema.encodeEffect(OrchestrationV2ThreadShellJson);
const decodeShell = Schema.decodeUnknownEffect(OrchestrationV2ThreadShellJson);
const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No session for metadata test"),
} as ProviderAdapterV2["Service"];
const database = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "skill-pick-" });
    return Sqlite.layerFromPath(dir + "/statev2.sqlite");
  }),
).pipe(Layer.provide(NodeServices.layer));
it.effect("persists create -> change -> server read -> web wire shell", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const threadId = ThreadId.make("skill-pick");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project"),
      title: "Pick",
      modelSelection: { instanceId, model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      skillSetId: "alpha",
    });
    expect((yield* orchestrator.getThreadRecords(threadId, [])).thread.skillSetId).toBe("alpha");
    const sql = yield* SqlClient.SqlClient;
    const persisted = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
    expect(JSON.parse(persisted[0]!.payload_json).skillSetId).toBeUndefined();
    const events = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_events WHERE stream_id = ${threadId}`;
    expect(events.every((row) => JSON.parse(row.payload_json).skillSetId === undefined)).toBe(true);
    const createdShell = threadShellFromProjection(
      yield* orchestrator.getThreadProjection(threadId),
    );
    const createdClient = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "thread.updated",
      sequence: 3,
      location: "active",
      thread: createdShell,
    });
    expect(createdClient.threads.find((thread) => thread.id === threadId)?.skillSetId).toBe(
      "alpha",
    );
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("change"),
      threadId,
      skillSetId: "beta",
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    expect(projection.thread.skillSetId).toBe("beta");
    const shell = threadShellFromProjection(projection);
    const wire = yield* encodeShell(shell);
    const decoded = yield* decodeShell(JSON.parse(JSON.stringify(wire)));
    const client = applyShellStreamEvent(createdClient, {
      kind: "thread.updated",
      sequence: 4,
      location: "active",
      thread: decoded,
    });
    expect(client.threads.find((thread) => thread.id === threadId)?.skillSetId).toBe("beta");
    yield* sql`DELETE FROM orchestration_events WHERE stream_id = ${threadId} AND event_type = 'thread.metadata-updated'`;
    yield* Effect.gen(function* () {
      const events = yield* ApplicationEvents.OrchestrationEventStore;
      const liveStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const [stored] = yield* events.appendAgentEvents({
              events: [
                {
                  id: EventId.make("rolled-back-pick"),
                  threadId,
                  type: "thread.metadata-updated",
                  occurredAt: now,
                  payload: { ...projection.thread, skillSetId: "uncommitted" },
                },
              ],
            });
            yield* liveStore.apply(stored!.event);
            expect((yield* liveStore.getThread(threadId)).skillSetId).toBe("uncommitted");
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.result);
      expect((yield* liveStore.getThread(threadId)).skillSetId).toBe("beta");
    }).pipe(
      Effect.provide(
        Layer.merge(Layer.fresh(ApplicationEvents.layer), Layer.fresh(ProjectionStore.layer)),
      ),
    );
    const nightly = Schema.fromJsonString(
      OrchestrationV2AppThreadJson.mapFields(Struct.omit(["skillSetId"])),
    );
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
    const rewritten = yield* Schema.decodeEffect(nightly)(rows[0]!.payload_json).pipe(
      Effect.flatMap(Schema.encodeEffect(nightly)),
    );
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${rewritten} WHERE thread_id = ${threadId}`;
    yield* Effect.gen(function* () {
      const restarted = yield* ProjectionStore.ProjectionStoreV2;
      expect((yield* restarted.getThread(threadId)).skillSetId).toBe("beta");
      expect((yield* restarted.getThreadShell(threadId))?.skillSetId).toBe("beta");
    }).pipe(Effect.provide(Layer.fresh(ProjectionStore.layer)));
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("clear"),
      threadId,
      skillSetId: null,
    });
    expect((yield* orchestrator.getThreadRecords(threadId, [])).thread.skillSetId).toBeNull();
  }).pipe(
    Effect.provide(
      Layer.merge(
        database,
        layerWithRegistry({ name: "skill-pick" }, layerFromAdapters([adapter]), {
          databaseLayer: database,
          runEffectWorker: false,
        }),
      ),
    ),
  ),
);
