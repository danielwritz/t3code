import {
  AGENT_INPUT_TEXT_MAX_CHARS,
  AgentInputNotFoundError,
  AgentInputReadError,
  ProviderDriverKind,
  type AgentInputFidelity,
  type AgentInputText,
  type AgentInputVerification,
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
import { antigravitySessionKey, loadAntigravitySessionFiles } from "./readers/antigravityFiles.ts";
import { readAntigravitySession } from "./readers/antigravitySession.ts";
import {
  makeClaudeIndexReader,
  makeClaudeRequestRebuilder,
  withRebuiltRequest,
  type ClaudeRequestIndex,
  type RebuiltClaudeRequest,
} from "./readers/claudeTranscript.ts";
import { makeCodexRolloutReader } from "./readers/codexRollout.ts";
import {
  makeLayer,
  type HarnessTrace,
  type TraceLayer,
  type TraceRequest,
} from "./readers/traceParts.ts";

interface ClaudeFile {
  readonly key: string;
  readonly path: string;
  readonly index: ClaudeRequestIndex;
}

interface BuiltTrace {
  readonly result: ThreadAgentInput;
  readonly layers: ReadonlyArray<TraceLayer>;
  readonly requests: ReadonlyArray<TraceRequest>;
  readonly claude: ClaudeFile | undefined;
}

interface HarnessRead {
  readonly trace: HarnessTrace | undefined;
  readonly source: string | undefined;
  readonly notes: ReadonlyArray<string>;
  readonly claude?: ClaudeFile;
}

interface CachedTrace {
  readonly trace: HarnessTrace;
  readonly bytes: number;
  readonly claude?: ClaudeFile;
  /** Requests rebuilt since, so their checks show without reading the file again. */
  readonly checks: Map<number, RebuiltClaudeRequest>;
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
// Parsed traces and rebuilt requests kept for the dialog; a changed file is read again.
const TRACE_CACHE_BYTES = 48 * 1024 * 1024;
const REQUEST_CACHE_BYTES = 32 * 1024 * 1024;
const rebuiltBytes = (rebuilt: RebuiltClaudeRequest) =>
  2 * (rebuilt.system.length + rebuilt.tools.length + rebuilt.messages.length);

/** Least recently used entries go first once the estimated bytes pass the budget. */
function makeByteCache<A>(budget: number, sizeOf: (value: A) => number) {
  const entries = new Map<string, A>();
  let total = 0;
  const drop = (key: string) => {
    const value = entries.get(key);
    if (value === undefined) return;
    entries.delete(key);
    total -= sizeOf(value);
  };
  return {
    get: (key: string) => {
      const value = entries.get(key);
      if (value === undefined) return undefined;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set: (key: string, value: A) => {
      drop(key);
      if (sizeOf(value) > budget) return value;
      entries.set(key, value);
      total += sizeOf(value);
      for (const oldest of entries.keys()) {
        if (total <= budget) break;
        drop(oldest);
      }
      return value;
    },
  };
}

const cachedTraceOf = (entry: CachedTrace) => {
  let trace = entry.trace;
  for (const [requestIndex, rebuilt] of entry.checks) {
    trace = withRebuiltRequest(trace, requestIndex, rebuilt);
  }
  return trace;
};

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
  const traces = makeByteCache<CachedTrace>(TRACE_CACHE_BYTES, (entry) => entry.bytes);
  const rebuiltRequests = makeByteCache(REQUEST_CACHE_BYTES, rebuiltBytes);

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
    return { key: `${filePath}\0${info.size}\0${modified}`, size: Number(info.size) };
  });

  const rebuildClaudeRequest = Effect.fn("AgentInputTrace.rebuildClaudeRequest")(function* (
    claude: ClaudeFile,
    requestIndex: number,
  ) {
    const cacheKey = `${claude.key}\0${requestIndex}`;
    const cached = rebuiltRequests.get(cacheKey);
    if (cached !== undefined) return cached;
    const rebuilder = makeClaudeRequestRebuilder(claude.index, requestIndex);
    yield* forEachLine(claude.path, rebuilder.accept);
    const rebuilt = rebuilder.finish();
    if (rebuilt === undefined) return undefined;
    traces.get(claude.key)?.checks.set(requestIndex, rebuilt);
    return rebuiltRequests.set(cacheKey, rebuilt);
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
    const { key } = yield* fileKey(transcriptPath);
    const source = "Claude Code transcript";
    const cached = traces.get(key);
    if (cached?.claude !== undefined) {
      return { trace: cachedTraceOf(cached), source, notes, claude: cached.claude };
    }
    const reader = makeClaudeIndexReader();
    yield* forEachLine(transcriptPath, reader.accept);
    const read = reader.finish();
    const claude = { key, path: transcriptPath, index: read.index };
    const entry: CachedTrace = {
      trace: read.trace,
      bytes: 2 * (read.trace.retainedChars ?? 0),
      claude,
      checks: new Map(),
    };
    traces.set(key, entry);
    if (read.latest !== undefined) {
      const rebuilt = yield* rebuildClaudeRequest(claude, read.latest);
      if (rebuilt !== undefined) entry.checks.set(read.latest, rebuilt);
    }
    return { trace: cachedTraceOf(entry), source, notes, claude };
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
    const { key, size } = yield* fileKey(rollout);
    const source = "Codex session file";
    const cached = traces.get(key);
    if (cached !== undefined) return { trace: cached.trace, source, notes: [] };
    const reader = makeCodexRolloutReader();
    yield* forEachLine(rollout, reader.accept);
    const trace = reader.finish();
    // Request parts keep the parsed rollout items, about the file's size.
    traces.set(key, { trace, bytes: 2 * size, checks: new Map() });
    return { trace, source, notes: [] };
  });

  const readAntigravity = Effect.fn("AgentInputTrace.readAntigravity")(function* (
    instanceId: ProviderInstanceId,
    nativeId: string,
  ) {
    const directories = yield* resolveAntigravityInstanceDirectories(stateDir, instanceId).pipe(
      Effect.provideService(Digest.Digest, digest),
      Effect.provideService(Path.Path, path),
    );
    const notFound = {
      ...NO_HARNESS,
      notes: ["Antigravity's session files for this thread were not found."],
    };
    const source = "Antigravity session files";
    const key = yield* Effect.tryPromise({
      try: () => antigravitySessionKey(directories.profile, nativeId),
      catch: (cause) => new AgentInputFileError({ cause }),
    });
    if (key === undefined) return notFound;
    // Each read walks every MCP tool file, so a dialog open or a layer click reuses it.
    const cached = traces.get(key);
    if (cached !== undefined) return { trace: cached.trace, source, notes: [] };
    const files = yield* Effect.tryPromise({
      try: () => loadAntigravitySessionFiles(directories.profile, nativeId),
      catch: (cause) => new AgentInputFileError({ cause }),
    });
    if (files === undefined) return notFound;
    const trace = readAntigravitySession(files);
    let textBytes = 0;
    for (const line of files.transcriptLines) textBytes += line.length;
    for (const tool of files.mcpTools) textBytes += tool.json.length;
    traces.set(key, { trace, bytes: 2 * textBytes, checks: new Map() });
    return { trace, source, notes: [] };
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
      if (harness.trace !== undefined && row.origin !== "t3" && row.origin !== "profile") continue;
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
        ? [
            "Only the text T3 Code handed to the agent is shown; the agent's own instructions are not.",
          ]
        : []),
    ];
    const profile = yield* store.latestProfileUse(threadId).pipe(Effect.mapError(storeError));
    const layers = [...harnessLayers, ...recorded];
    const requests = harness.trace?.requests ?? [];
    return {
      layers,
      requests,
      claude: harness.claude,
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
    let verification: AgentInputVerification | undefined;
    if (target.type === "layer") {
      text = built.layers.find((layer) => layer.id === target.layerId)?.text;
    } else if (built.claude !== undefined) {
      const rebuilt = yield* rebuildClaudeRequest(built.claude, target.index).pipe(
        Effect.mapError((cause) => new AgentInputReadError({ threadId: input.threadId, cause })),
      );
      text = rebuilt?.[target.part];
      verification = rebuilt?.verification;
    } else {
      const request = built.requests.find((candidate) => candidate.index === target.index);
      text = request?.partText?.(target.part);
      verification = request?.verification;
    }
    if (text === undefined) {
      return yield* new AgentInputNotFoundError({ threadId: input.threadId, missing: target.type });
    }
    const truncated = text.length > AGENT_INPUT_TEXT_MAX_CHARS;
    return {
      text: truncated ? text.slice(0, AGENT_INPUT_TEXT_MAX_CHARS) : text,
      chars: text.length,
      truncated,
      ...(verification === undefined ? {} : { verification }),
    };
  });

  return AgentInputTrace.of({ getThreadAgentInput, getThreadAgentInputText });
});

export const layer = Layer.effect(AgentInputTrace, make);
