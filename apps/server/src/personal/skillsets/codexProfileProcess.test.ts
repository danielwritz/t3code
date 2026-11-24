import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CodexSettings, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ServerConfig from "../../config.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as CodexAdapter from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as SkillSets from "./runtime.ts";
import { resolveHome, resolveProfile } from "./resolver.ts";
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeEffect(CodexSettings);

it.live("a thread that ignores its project resumes with the ignore-project thread config", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const executable = yield* HostProcess.ExecutablePath;
    const root = yield* fs.makeTempDirectoryScoped();
    const instance = path.join(root, "instance");
    const profile = path.join(root, "profile");
    yield* fs.makeDirectory(path.join(instance, "sessions"), { recursive: true });
    yield* fs.writeFileString(path.join(instance, "config.toml"), "");
    yield* fs.makeDirectory(profile);
    const script = path.join(root, "script.json");
    yield* fs.writeFileString(
      script,
      yield* encodeJson({ rootThreadId: "fixture", notifications: [], recordRequests: true }),
    );
    const fixture = path.resolve(
      import.meta.dirname,
      "../../provider/testFixtures/codexCollabMockPeer.mjs",
    );
    // Every Codex process, the session and the discovery helpers, is the mock app-server.
    const mockSpawner = ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command))
        return Effect.die("Expected one app-server command");
      return spawner.spawn(
        ChildProcess.make(executable, [fixture, ...command.args], {
          ...command.options,
          shell: false,
          env: { ...command.options.env, T3_CODEX_COLLAB_SCRIPT: script },
        }),
      );
    });
    const factory = yield* CodexAdapter.CodexAppServerClientFactory.pipe(
      Effect.provide(
        CodexAdapter.layerAppServerClientFactory.pipe(
          Layer.provide(PortScanner.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, mockSpawner)),
        ),
      ),
    );
    const ignored = new Map<string, boolean>();
    const deps = {
      stateDir: path.join(root, "state"),
      settings: {
        skillSetsEnabled: true,
        defaultSkillSetId: "alpha",
        skillSets: {
          alpha: {
            name: "Alpha",
            source: { kind: "local" as const, path: profile },
            enabled: true,
            autoSync: false,
            disabledSkills: [],
          },
        },
      },
      statuses: [
        {
          id: "alpha",
          state: "local" as const,
          ready: true,
          commit: null,
          commitDate: null,
          lastChecked: null,
          error: null,
          skills: [],
        },
      ],
      warn: () => {},
      threadIgnoresProject: async (threadId: string) => ignored.get(threadId) ?? null,
    };
    const service = SkillSets.SkillSets.of({
      statuses: Effect.succeed([]),
      changes: Stream.empty,
      syncNow: () => Effect.succeed([]),
      resolveHome: (driver, home, thread) =>
        Effect.promise(() => resolveHome(deps, driver, home, thread)),
      resolveProfile: (driver, thread) =>
        Effect.promise(() => resolveProfile(deps, driver, thread)),
    });
    const adapter = yield* CodexAdapter.makeCodexAdapterV2({
      instanceId: ProviderInstanceId.make("codex-profile-process"),
      settings: yield* decodeSettings({ homePath: instance }),
      environment: { T3_CODEX_COLLAB_SCRIPT: script },
      clientFactory: factory,
      digest: yield* Digest.Digest,
      fileSystem: fs,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig,
    }).pipe(
      Effect.provideService(SkillSets.SkillSets, service),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mockSpawner),
    );
    const input = {
      threadId: ThreadId.make("ignoring-thread"),
      providerSessionId: ProviderSessionId.make("profile-session"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex-profile-process"),
        model: "fixture-model",
      },
      runtimePolicy: {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd: root,
      },
      skillSetId: "alpha",
    };
    const session = yield* adapter.openSession(input);
    const providerThread = yield* session.ensureThread(input);
    const requests = `${script}.requests`;
    const resumes = Effect.gen(function* () {
      const text = (yield* fs.exists(requests)) ? yield* fs.readFileString(requests) : "";
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; params: { config?: unknown } })
        .filter((entry) => entry.method === "thread/resume");
    });
    yield* session.resumeThread({ ...input, providerThread });
    expect((yield* resumes).at(-1)?.params.config).not.toHaveProperty("project_doc_max_bytes");
    ignored.set("ignoring-thread", true);
    yield* session.resumeThread({ ...input, providerThread });
    expect((yield* resumes).at(-1)?.params.config).toMatchObject({ project_doc_max_bytes: 0 });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(".", { prefix: "codex-profile-process-" }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            IdAllocator.layer,
            McpProviderSessions.layer,
          ),
        ),
      ),
    ),
  ),
);
