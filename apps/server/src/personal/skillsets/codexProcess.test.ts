import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CodexSettings, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as Stream from "effect/Stream";
import * as Logger from "effect/Logger";
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
import { makeSessionInputIdentities } from "./sessionIdentity.ts";
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeEffect(CodexSettings);

it.live(
  "Codex changes the process home and resumes the native thread only when its skill-set identity changes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const executable = yield* HostProcess.ExecutablePath;
      const root = yield* fs.makeTempDirectoryScoped();
      const alpha = path.join(root, "alpha");
      const beta = path.join(root, "beta");
      const instance = path.join(root, "instance");
      yield* fs.makeDirectory(path.join(instance, "sessions"), { recursive: true });
      yield* fs.makeDirectory(path.join(alpha, "sessions"), { recursive: true });
      yield* fs.makeDirectory(path.join(beta, "sessions"), { recursive: true });
      const script = path.join(root, "script.json");
      const records = path.join(root, "launches.jsonl");
      yield* fs.writeFileString(
        script,
        yield* encodeJson({
          rootThreadId: "fixture",
          notifications: [],
          launchRecordsPath: records,
          recordRequests: true,
        }),
      );
      const fixture = path.resolve(
        import.meta.dirname,
        "../../provider/testFixtures/codexCollabMockPeer.mjs",
      );
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
            Layer.provide(
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make((command) => {
                  if (!ChildProcess.isStandardCommand(command))
                    return Effect.die("Expected one app-server command");
                  return spawner.spawn(
                    ChildProcess.make(executable, [fixture, ...command.args], command.options),
                  );
                }),
              ),
            ),
          ),
        ),
      );
      const settings = yield* decodeSettings({ homePath: instance });
      let resolution: "built" | "off" | "failure" = "built";
      const service = SkillSets.SkillSets.of({
        statuses: Effect.succeed([]),
        changes: Stream.empty,
        syncNow: () => Effect.succeed([]),
        resolveHome: (_driver, _instance, thread) =>
          resolution === "failure"
            ? Effect.die("fixture resolver failure")
            : resolution === "off"
              ? Effect.undefined
              : Effect.succeed({
                  homePath: thread.skillSetId === "beta" ? beta : alpha,
                  skillsDir: "unused",
                  skills: [],
                }),
      });
      const adapter = yield* CodexAdapter.makeCodexAdapterV2({
        instanceId: ProviderInstanceId.make("codex-fixture"),
        settings,
        environment: { T3_CODEX_COLLAB_SCRIPT: script },
        clientFactory: factory,
        digest: yield* Digest.Digest,
        fileSystem: fs,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig,
      }).pipe(
        Effect.provideService(SkillSets.SkillSets, service),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.die("Discovery deliberately unavailable in the process-restart fixture"),
          ),
        ),
      );
      const input = {
        threadId: ThreadId.make("fixture-thread"),
        providerSessionId: ProviderSessionId.make("fixture-session"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex-fixture"),
          model: "fixture-model",
        },
        runtimePolicy: {
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          cwd: root,
        },
        skillSetId: "alpha",
      };
      const identities = makeSessionInputIdentities();
      const firstScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
      const first = yield* adapter
        .openSession(input)
        .pipe(Effect.provideService(Scope.Scope, firstScope));
      const providerThread = yield* first.ensureThread(input);
      yield* identities.remember(first, input);
      expect(yield* identities.changed(first, input)).toBe(false);
      expect((yield* fs.readFileString(records)).trim().split("\n")).toHaveLength(1);
      const warnings: unknown[] = [];
      const logging = Logger.layer([
        Logger.make(({ message }) => {
          warnings.push(message);
        }),
      ]);
      const attachedInput = {
        ...input,
        threadId: ThreadId.make("attached-thread"),
        skillSetId: "beta",
      };
      expect(yield* identities.changed(first, attachedInput).pipe(Effect.provide(logging))).toBe(
        false,
      );
      expect(yield* identities.changed(first, attachedInput).pipe(Effect.provide(logging))).toBe(
        false,
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toEqual(
        expect.arrayContaining([{ sessionSkillSet: "alpha", requestedSkillSet: "beta" }]),
      );
      expect((yield* fs.readFileString(records)).trim().split("\n")).toHaveLength(1);
      const independentInput = {
        ...input,
        threadId: ThreadId.make("independent-root"),
        providerSessionId: ProviderSessionId.make("independent-session"),
        skillSetId: "beta",
      };
      const independent = yield* adapter.openSession(independentInput);
      yield* independent.ensureThread(independentInput);
      yield* identities.remember(independent, independentInput);
      expect(yield* identities.changed(first, input)).toBe(false);
      const nextInput = {
        ...input,
        skillSetId: "beta",
        initialNativeThreadId: providerThread.nativeThreadRef!.nativeId!,
      };
      expect(yield* identities.changed(first, nextInput, true)).toBe(false);
      expect(yield* identities.changed(first, nextInput)).toBe(true);
      yield* Scope.close(firstScope, Exit.void);
      const second = yield* adapter.openSession(nextInput);
      const resumed = yield* second.resumeThread({ ...input, providerThread });
      expect(resumed.nativeThreadRef?.nativeId).toBe(providerThread.nativeThreadRef?.nativeId);
      const launches = (yield* fs.readFileString(records)).trim().split("\n");
      expect(launches).toHaveLength(3);
      expect(launches[0]).toContain(alpha.replaceAll("\\", "\\\\"));
      expect(launches[1]).toContain(beta.replaceAll("\\", "\\\\"));
      expect(launches[2]).toContain(beta.replaceAll("\\", "\\\\"));
      expect(yield* identities.changed(independent, independentInput)).toBe(false);
      expect(yield* fs.readFileString(`${script}.requests`)).toContain('"method":"thread/resume"');
      for (const mode of ["off", "failure"] as const) {
        resolution = mode;
        const fallbackInput = {
          ...input,
          threadId: ThreadId.make(`root-${mode}`),
          providerSessionId: ProviderSessionId.make(`session-${mode}`),
        };
        const fallback = yield* adapter.openSession(fallbackInput);
        yield* fallback.ensureThread(fallbackInput);
        const launches = (yield* fs.readFileString(records)).trim().split("\n");
        expect(launches.at(-1)).toContain(instance.replaceAll("\\", "\\\\"));
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(".", { prefix: "codex-skill-set-process-" }).pipe(
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
