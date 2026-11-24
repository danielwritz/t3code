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
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("clear"),
      threadId,
      skillSetId: null,
    });
    expect((yield* orchestrator.getThreadRecords(threadId, [])).thread.skillSetId).toBeNull();
  }).pipe(
    Effect.provide(
      layerWithRegistry({ name: "skill-pick" }, layerFromAdapters([adapter]), {
        runEffectWorker: false,
      }),
    ),
  ),
);
