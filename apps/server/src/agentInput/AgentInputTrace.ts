import {
  AGENT_INPUT_TEXT_MAX_CHARS,
  AgentInputNotFoundError,
  AgentInputReadError,
  ProviderDriverKind,
  type AgentInputFidelity,
  type AgentInputText,
  type GetThreadAgentInputInput,
  type GetThreadAgentInputTextInput,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ThreadAgentInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { resolveAgentHarnessHome } from "../project/AgentSessionScanner.ts";
import { resolveAntigravityInstanceDirectories } from "../provider/antigravityAuthSupport.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentInputStore from "./AgentInputStore.ts";
import { loadAntigravitySessionFiles } from "./readers/antigravityFiles.ts";
import { readAntigravitySession } from "./readers/antigravitySession.ts";
import { makeClaudeTranscriptReader } from "./readers/claudeTranscript.ts";
import { makeCodexRolloutReader } from "./readers/codexRollout.ts";
import {
  makeLayer,
  type HarnessTrace,
  type TraceLayer,
  type TraceRequest,
} from "./readers/traceParts.ts";

interface BuiltTrace {
  readonly result: ThreadAgentInput;
  readonly layers: ReadonlyArray<TraceLayer>;
  readonly requests: ReadonlyArray<TraceRequest>;
}

interface HarnessRead {
  readonly trace: HarnessTrace | undefined;
  readonly source: string | undefined;
  readonly notes: ReadonlyArray<string>;
}

class AgentInputFileError extends Schema.TaggedError<AgentInputFileError>()("AgentInputFileError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Could not read the agent's session files.";
  }
}

const NO_HARNESS: HarnessRead = { trace: undefined, source: undefined, notes: [] };
const isThreadNotFound = Schema.is(ProjectionStoreThreadNotFoundError);
const CODEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Parsed harness traces kept for the dialog's text reads; a changed file is read again.
const CACHE_ENTRIES = 4;

const normalized = (text: string) => text.replaceAll(/\s+/g, " ").trim();

/** Reads what each thread's agent received: the harness's own record plus what T3 recorded. */
export class AgentInputTrace extends Context.Service<
  AgentInputTrace,
  {
    readonly getThreadAgentInput: (
      input: GetThreadAgentInputInput,
    ) => Effect.Effect<ThreadAgentInput, AgentInputNotFoundError | AgentInputReadError>;
    readonly getThreadAgentInputText: (
      input: GetThreadAgentInputTextInput,
    ) => Effect.Effect<AgentInputText, AgentInputNotFoundError | AgentInputReadError>;
  }
>()("t3/agentInput/AgentInputTrace") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const store = yield* AgentInputStore.AgentInputStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const cache = new Map<string, HarnessTrace>();

  const remember = (key: string, trace: HarnessTrace) => {
    cache.delete(key);
    cache.set(key, trace);
    for (const oldest of cache.keys()) {
      if (cache.size <= CACHE_ENTRIES) break;
      cache.delete(oldest);
    }
    return trace;
  };

  const listDirectory = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));

  const forEachLine = (filePath: string, accept: (line: string) => void) =>
    fileSystem.stream(filePath).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Effect.sync(() => accept(line))),
    );

  const fileKey = Effect.fn("AgentInputTrace.fileKey")(function* (filePath: string) {
    const info = yield* fileSystem.stat(filePath);
    const modified = info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0;
    return `${filePath}\0${info.size}\0${modified}`;
  });

  const instanceConfig = Effect.fn("AgentInputTrace.instanceConfig")(function* (
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => undefined));
    const configured: ProviderInstanceConfig | undefined = settings?.providerInstances[instanceId];
    return configured ?? { driver };
  });

  const readClaude = Effect.fn("AgentInputTrace.readClaude")(function* (
    instanceId: ProviderInstanceId,
    nativeId: string,
  ) {
    const home = yield* resolveAgentHarnessHome(
      "claudeAgent",
      yield* instanceConfig(instanceId, ProviderDriverKind.make("claudeAgent")),
    );
    if (home === undefined)
      return { ...NO_HARNESS, notes: ["The Claude settings for this thread could not be read."] };
    const projectsDir = path.join(home, "projects");
    let transcriptPath: string | undefined;
    for (const folder of yield* listDirectory(projectsDir)) {
      const candidate = path.join(projectsDir, folder, `${nativeId}.jsonl`);
      if (yield* exists(candidate)) {
        transcriptPath = candidate;
        break;
      }
    }
    if (transcriptPath === undefined) {
      return { ...NO_HARNESS, notes: ["Claude Code's transcript for this thread was not found."] };
    }
    const notes: Array<string> = [];
    const subagents = (yield* listDirectory(
      path.join(path.dirname(transcriptPath), nativeId, "subagents"),
    )).filter((name) => name.endsWith(".jsonl"));
    if (subagents.length > 0) {
      notes.push(`${subagents.length} subagent transcripts are not shown yet.`);
    }
    const key = yield* fileKey(transcriptPath);
    const cached = cache.get(key);
    if (cached !== undefined) return { trace: cached, source: "Claude Code transcript", notes };
    const reader = makeClaudeTranscriptReader();
    yield* forEachLine(transcriptPath, reader.acceptFirst);
    if (reader.prepareSecondPass()) {
      yield* forEachLine(transcriptPath, reader.acceptSecond);
      reader.finishSecondPass();
    }
    return {
      trace: remember(key, reader.finish()),
      source: "Claude Code transcript",
      notes,
    };
  });

  const findCodexRollout = Effect.fn("AgentInputTrace.findCodexRollout")(function* (
    sessionsDir: string,
    nativeId: string,
  ) {
    const matches = (name: string) =>
      name.startsWith("rollout-") &&
      (name.endsWith(`-${nativeId}.jsonl`) || name.endsWith(`-${nativeId}.jsonl.zst`));
    const inDay = Effect.fn("AgentInputTrace.findCodexRolloutInDay")(function* (day: string) {
      const name = (yield* listDirectory(day)).find(matches);
      return name === undefined ? undefined : path.join(day, name);
    });
    // Codex thread ids are UUIDv7, so the id dates the folder; rollouts use local dates.
    if (CODEX_UUID.test(nativeId)) {
      const startedAt = Number.parseInt(nativeId.replaceAll("-", "").slice(0, 12), 16);
      // Folder dates are local; the day either side of the UTC day covers every offset.
      for (const offset of [0, -1, 1]) {
        const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(startedAt + offset * 86_400_000));
        const day = path.join(
          sessionsDir,
          String(parts.year),
          String(parts.month).padStart(2, "0"),
          String(parts.day).padStart(2, "0"),
        );
        const found = yield* inDay(day);
        if (found !== undefined) return found;
      }
    }
    for (const year of (yield* listDirectory(sessionsDir)).toSorted().toReversed()) {
      for (const month of (yield* listDirectory(path.join(sessionsDir, year)))
        .toSorted()
        .toReversed()) {
        for (const day of (yield* listDirectory(path.join(sessionsDir, year, month)))
          .toSorted()
          .toReversed()) {
          const found = yield* inDay(path.join(sessionsDir, year, month, day));
          if (found !== undefined) return found;
        }
      }
    }
    return undefined;
  });

  const readCodex = Effect.fn("AgentInputTrace.readCodex")(function* (
    instanceId: ProviderInstanceId,
    nativeId: string,
  ) {
    const home = yield* resolveAgentHarnessHome(
      "codex",
      yield* instanceConfig(instanceId, ProviderDriverKind.make("codex")),
    );
    if (home === undefined)
      return { ...NO_HARNESS, notes: ["The Codex settings for this thread could not be read."] };
    const rollout = yield* findCodexRollout(path.join(home, "sessions"), nativeId);
    if (rollout === undefined) {
      return { ...NO_HARNESS, notes: ["Codex's session file for this thread was not found."] };
    }
    if (rollout.endsWith(".zst")) {
      return {
        ...NO_HARNESS,
        notes: [
          "Codex compressed this session file; compressed session files are not supported yet.",
        ],
      };
    }
    const key = yield* fileKey(rollout);
    const cached = cache.get(key);
    if (cached !== undefined) return { trace: cached, source: "Codex session file", notes: [] };
    const reader = makeCodexRolloutReader();
    yield* forEachLine(rollout, reader.accept);
    return { trace: remember(key, reader.finish()), source: "Codex session file", notes: [] };
  });

  const readAntigravity = Effect.fn("AgentInputTrace.readAntigravity")(function* (
    instanceId: ProviderInstanceId,
    nativeId: string,
  ) {
    const directories = yield* resolveAntigravityInstanceDirectories(stateDir, instanceId).pipe(
      Effect.provideService(Digest.Digest, digest),
      Effect.provideService(Path.Path, path),
    );
    const files = yield* Effect.tryPromise({
      try: () => loadAntigravitySessionFiles(directories.profile, nativeId),
      catch: (cause) => new AgentInputFileError({ cause }),
    });
    if (files === undefined) {
      return {
        ...NO_HARNESS,
        notes: ["Antigravity's session files for this thread were not found."],
      };
    }
    return { trace: readAntigravitySession(files), source: "Antigravity session files", notes: [] };
  });

  const readHarness = (
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    nativeId: string | undefined,
  ): Effect.Effect<HarnessRead> => {
    const read =
      driver === "claudeAgent"
        ? readClaude
        : driver === "codex"
          ? readCodex
          : driver === "antigravity"
            ? readAntigravity
            : undefined;
    if (read === undefined) return Effect.succeed(NO_HARNESS);
    if (nativeId === undefined) {
      return Effect.succeed({ ...NO_HARNESS, notes: ["The agent has not started a session yet."] });
    }
    // File problems lower the fidelity; they never fail the trace.
    const harness: Effect.Effect<
      HarnessRead,
      PlatformError.PlatformError | AgentInputFileError,
      Path.Path
    > = read(instanceId, nativeId);
    return harness.pipe(
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() =>
        Effect.succeed<HarnessRead>({
          ...NO_HARNESS,
          notes: ["The agent's session record could not be read."],
        }),
      ),
    );
  };

  const activeProviderThread = (
    activeId: string | null,
    providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>,
  ) =>
    providerThreads.find((candidate) => candidate.id === activeId) ??
    providerThreads.toSorted(
      (a, b) => Number(b.updatedAt.epochMilliseconds) - Number(a.updatedAt.epochMilliseconds),
    )[0];

  const buildTrace = Effect.fn("AgentInputTrace.buildTrace")(function* (threadId: ThreadId) {
    const { thread, providerThreads } = yield* threads
      .getThreadRecords(threadId, ["providerThreads"])
      .pipe(
        Effect.mapError((cause) =>
          isThreadNotFound(cause.cause)
            ? new AgentInputNotFoundError({ threadId, missing: "thread" })
            : new AgentInputReadError({ threadId, cause }),
        ),
      );
    const active = activeProviderThread(thread.activeProviderThreadId, providerThreads);
    const providerInstanceId = active?.providerInstanceId ?? thread.providerInstanceId;
    const driver =
      active?.driver ??
      (yield* instanceConfig(providerInstanceId, ProviderDriverKind.make(providerInstanceId)))
        .driver;
    const nativeSessionId = active?.nativeThreadRef?.nativeId ?? undefined;
    const harness = yield* readHarness(driver, providerInstanceId, nativeSessionId);
    const storeError = (cause: unknown) => new AgentInputReadError({ threadId, cause });
    const rows = yield* store.listRecords(threadId).pipe(Effect.mapError(storeError));

    const harnessLayers = harness.trace?.layers ?? [];
    const known = new Set(harnessLayers.map((layer) => normalized(layer.text)));
    const joinedByKind = new Map<string, string>();
    for (const layer of harnessLayers) {
      joinedByKind.set(
        layer.kind,
        `${joinedByKind.get(layer.kind) ?? ""}\n${normalized(layer.text)}`,
      );
    }
    const recorded: Array<TraceLayer> = [];
    for (const row of rows) {
      if (harness.trace !== undefined && row.origin !== "t3") continue;
      const text = (yield* store.readText(row.sha256).pipe(Effect.mapError(storeError))) ?? "";
      const key = normalized(text);
      if (key.length === 0 || known.has(key) || joinedByKind.get(row.kind)?.includes(key)) continue;
      recorded.push(
        makeLayer({
          id: `recorded:${row.id}`,
          kind: row.kind,
          origin: row.origin,
          title: row.title,
          text,
          at: row.recordedAt,
        }),
      );
    }

    const fidelity: AgentInputFidelity =
      harness.trace?.fidelity ?? (recorded.length > 0 ? "t3-recorded" : "none");
    const notes = [
      ...(providerThreads.length > 1
        ? [
            `This thread used ${providerThreads.length} agent sessions; only the active one is shown.`,
          ]
        : []),
      ...harness.notes,
      ...(harness.trace?.notes ?? []),
      ...(harness.trace === undefined && fidelity === "t3-recorded"
        ? ["Only the text T3 handed to the agent is shown; the agent's own instructions are not."]
        : []),
      ...(fidelity === "none" ? ["Nothing was recorded for this thread yet."] : []),
    ];
    const profile = yield* store.latestProfileUse(threadId).pipe(Effect.mapError(storeError));
    const layers = [...harnessLayers, ...recorded];
    const requests = harness.trace?.requests ?? [];
    return {
      layers,
      requests,
      result: {
        threadId,
        driver,
        providerInstanceId,
        ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
        fidelity,
        source: harness.source ?? (recorded.length > 0 ? "Recorded by T3 Code" : "No record"),
        layers: layers.map(({ text: _text, ...layer }) => layer),
        requests: requests.map(({ partText: _partText, ...request }) => request),
        ...(profile === undefined ? {} : { profile }),
        notes,
      },
    } satisfies BuiltTrace;
  });

  const getThreadAgentInput = Effect.fn("AgentInputTrace.getThreadAgentInput")(function* (
    input: GetThreadAgentInputInput,
  ) {
    return (yield* buildTrace(input.threadId)).result;
  });

  const getThreadAgentInputText = Effect.fn("AgentInputTrace.getThreadAgentInputText")(function* (
    input: GetThreadAgentInputTextInput,
  ) {
    const built = yield* buildTrace(input.threadId);
    const { target } = input;
    let text: string | undefined;
    if (target.type === "layer") {
      text = built.layers.find((layer) => layer.id === target.layerId)?.text;
    } else {
      text = built.requests
        .find((request) => request.index === target.index)
        ?.partText(target.part);
    }
    if (text === undefined) {
      return yield* new AgentInputNotFoundError({ threadId: input.threadId, missing: target.type });
    }
    const truncated = text.length > AGENT_INPUT_TEXT_MAX_CHARS;
    return {
      text: truncated ? text.slice(0, AGENT_INPUT_TEXT_MAX_CHARS) : text,
      chars: text.length,
      truncated,
    };
  });

  return AgentInputTrace.of({ getThreadAgentInput, getThreadAgentInputText });
});

export const layer = Layer.effect(AgentInputTrace, make);
