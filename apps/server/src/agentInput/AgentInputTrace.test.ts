import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentInputStore from "./AgentInputStore.ts";
import * as AgentInputTrace from "./AgentInputTrace.ts";

const codexThread = ThreadId.make("thread-codex");
const cursorThread = ThreadId.make("thread-cursor");
const missingThread = ThreadId.make("thread-missing");
const T3_RUNTIME = "<t3_code_runtime>Running in T3 Code.</t3_code_runtime>";

const providerThread = (driver: string, nativeId: string) => ({
  id: `provider-${driver}`,
  driver: ProviderDriverKind.make(driver),
  providerInstanceId: ProviderInstanceId.make(driver),
  nativeThreadRef: { driver, nativeId, strength: "strong" },
  updatedAt: DateTime.makeUnsafe(0),
});

const records = (threadId: ThreadId) => {
  if (threadId === missingThread) {
    return Effect.fail(
      new OrchestratorProjectionError({
        threadId,
        cause: new ProjectionStoreThreadNotFoundError({ threadId }),
      }),
    );
  }
  const driver = threadId === codexThread ? "codex" : "cursor";
  return Effect.succeed({
    thread: {
      id: threadId,
      providerInstanceId: ProviderInstanceId.make(driver),
      activeProviderThreadId: `provider-${driver}`,
    },
    providerThreads: [providerThread(driver, "native-1")],
  } as never);
};

const rollout = [
  { type: "session_meta", payload: { base_instructions: { text: "Base rules." } } },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: T3_RUNTIME }],
    },
  },
  {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix it." }] },
  },
  { type: "token_usage_record", payload: {} },
]
  .map((line) => JSON.stringify(line))
  .join("\n");

const traceLayer = (codexHome: string) =>
  AgentInputTrace.layer.pipe(
    Layer.provideMerge(AgentInputStore.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({ getThreadRecords: records }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            providerInstances: { codex: { driver: "codex", config: { homePath: codexHome } } },
          } as never),
        }),
      ),
    ),
  );

const withTrace = <A, E>(
  use: Effect.Effect<A, E, AgentInputTrace.AgentInputTrace | AgentInputStore.AgentInputStore>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "agent-input-codex-" });
    const day = path.join(home, "sessions", "2026", "01", "01");
    yield* fileSystem.makeDirectory(day, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(day, "rollout-2026-01-01T00-00-00-native-1.jsonl"),
      rollout,
    );
    return yield* use.pipe(Effect.provide(traceLayer(home)));
  }).pipe(Effect.scoped);

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    SqlitePersistence.layerMemory,
    ServerConfig.layerTest(process.cwd(), { prefix: "agent-input-trace-" }).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
)("AgentInputTrace", (it) => {
  it.effect("reads the harness record and adds only new T3 text from the recorder", () =>
    withTrace(
      Effect.gen(function* () {
        const store = yield* AgentInputStore.AgentInputStore;
        const trace = yield* AgentInputTrace.AgentInputTrace;
        const recorded = {
          threadId: codexThread,
          kind: "host-instructions",
          origin: "t3",
        } as const;
        yield* store.record({ ...recorded, title: "Runtime", text: T3_RUNTIME });
        yield* store.record({ ...recorded, title: "Extra", text: "<t3_extra>New.</t3_extra>" });
        yield* store.record({
          threadId: codexThread,
          kind: "user-prompt",
          origin: "user",
          title: "User message",
          text: "Fix it.",
        });
        const result = yield* trace.getThreadAgentInput({ threadId: codexThread });
        expect(result.fidelity).toBe("harness-record");
        expect(result.source).toBe("Codex session file");
        expect(result.layers.map((layer) => [layer.kind, layer.title])).toEqual([
          ["system-prompt", "Base instructions"],
          ["host-instructions", "t3_code_runtime"],
          ["user-prompt", "User message"],
          ["host-instructions", "Extra"],
        ]);
        const text = yield* trace.getThreadAgentInputText({
          threadId: codexThread,
          target: { type: "request", index: 0, part: "messages" },
        });
        expect(text.truncated).toBe(false);
        expect(text.text).toContain("Fix it.");
      }),
    ),
  );

  it.effect("falls back to recorded text for providers without a reader", () =>
    withTrace(
      Effect.gen(function* () {
        const store = yield* AgentInputStore.AgentInputStore;
        const trace = yield* AgentInputTrace.AgentInputTrace;
        yield* store.record({
          threadId: cursorThread,
          kind: "user-prompt",
          origin: "user",
          title: "User message",
          text: "Hello.",
        });
        const result = yield* trace.getThreadAgentInput({ threadId: cursorThread });
        expect(result.fidelity).toBe("t3-recorded");
        expect(result.layers.map((layer) => layer.preview)).toEqual(["Hello."]);
        const missingLayer = yield* trace
          .getThreadAgentInputText({
            threadId: cursorThread,
            target: { type: "layer", layerId: "nope" },
          })
          .pipe(Effect.flip);
        expect(missingLayer._tag === "AgentInputNotFoundError" && missingLayer.missing).toBe(
          "layer",
        );
        const missing = yield* trace
          .getThreadAgentInput({ threadId: missingThread })
          .pipe(Effect.flip);
        expect(missing._tag).toBe("AgentInputNotFoundError");
      }),
    ),
  );
});
