import {
  InstructionProfileNotFoundError,
  InstructionProfileStoreError,
  type InstructionProfile,
  type InstructionProfileDefaults,
  type InstructionProfileSource,
  type InstructionProfileSupportResult,
  type ListInstructionProfilesResult,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type SaveInstructionProfileInput,
  type SetDefaultInstructionProfileInput,
  type SetProjectInstructionProfileInput,
  type SetThreadInstructionProfileInput,
  type ThreadId,
  type ThreadInstructionProfile,
} from "@t3tools/contracts";
import {
  instructionProfileSupportTable,
  planInstructionProfile,
  type InstructionProfileLaunch,
} from "@t3tools/provider-core/server/instructionProfilePlan";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { InstructionProfilesRepository } from "../persistence/InstructionProfiles.ts";
import { resolveAgentHarnessHome } from "../project/AgentSessionScanner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { parseCodexConfigMcpServerNames } from "./codexConfigMcpServers.ts";

type ProfileError = InstructionProfileNotFoundError | InstructionProfileStoreError;

/** Saved instruction profiles, the thread -> project -> default choice, and launch plans. */
export class InstructionProfiles extends Context.Service<
  InstructionProfiles,
  {
    readonly list: Effect.Effect<ListInstructionProfilesResult, ProfileError>;
    readonly save: (
      input: SaveInstructionProfileInput,
    ) => Effect.Effect<InstructionProfile, ProfileError>;
    readonly remove: (id: string) => Effect.Effect<void, ProfileError>;
    readonly getThreadProfile: (
      threadId: ThreadId,
    ) => Effect.Effect<ThreadInstructionProfile, ProfileError>;
    readonly setThreadProfile: (
      input: SetThreadInstructionProfileInput,
    ) => Effect.Effect<ThreadInstructionProfile, ProfileError>;
    readonly getDefaults: Effect.Effect<InstructionProfileDefaults, ProfileError>;
    readonly setDefault: (
      input: SetDefaultInstructionProfileInput,
    ) => Effect.Effect<InstructionProfileDefaults, ProfileError>;
    readonly setProject: (
      input: SetProjectInstructionProfileInput,
    ) => Effect.Effect<InstructionProfileDefaults, ProfileError>;
    readonly support: InstructionProfileSupportResult;
    /** The thread's profile planned for one driver; undefined when no profile applies. */
    readonly launchFor: (input: {
      readonly threadId: ThreadId;
      readonly driver: ProviderDriverKind;
      readonly instanceId: ProviderInstanceId;
    }) => Effect.Effect<InstructionProfileLaunch | undefined, ProfileError>;
    /** Undefined records a launch without a profile, so the trace stops showing the last one. */
    readonly recordLaunch: (input: {
      readonly threadId: ThreadId;
      readonly driver: ProviderDriverKind;
      readonly launch: InstructionProfileLaunch | undefined;
    }) => Effect.Effect<void, ProfileError>;
  }
>()("t3/instructionProfiles/InstructionProfiles") {}

// The SQL cause can carry bound profile text, so it never leaves the server.
const storeError = (operation: string) => () => new InstructionProfileStoreError({ operation });

const make = Effect.gen(function* () {
  const repository = yield* InstructionProfilesRepository;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  // Every turn asks for a profile; with none chosen anywhere that answer is kept until a choice
  // changes. The version stops a read that raced a change from being kept.
  let choiceVersion = 0;
  let anyChoice: boolean | undefined;
  const choicesChanged = Effect.sync(() => {
    choiceVersion++;
    anyChoice = undefined;
  });
  const hasAnyChoice = Effect.gen(function* () {
    if (anyChoice !== undefined) return anyChoice;
    const version = choiceVersion;
    const chosen = yield* repository.hasAnyChoice.pipe(Effect.mapError(storeError("read")));
    if (version === choiceVersion) anyChoice = chosen;
    return chosen;
  });

  const requireProfile = Effect.fn("InstructionProfiles.requireProfile")(function* (id: string) {
    const profile = yield* repository.get(id).pipe(Effect.mapError(storeError("read")));
    if (profile === undefined) {
      return yield* new InstructionProfileNotFoundError({ missing: "profile", id });
    }
    return profile;
  });

  const requireThread = Effect.fn("InstructionProfiles.requireThread")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* projections
      .findThread(threadId)
      .pipe(Effect.mapError(storeError("read")));
    if (thread === null) {
      return yield* new InstructionProfileNotFoundError({ missing: "thread", id: threadId });
    }
    return thread;
  });

  const getDefaults = repository.getScopes.pipe(
    Effect.map((scopes): InstructionProfileDefaults => ({
      defaultProfileId: scopes.defaultProfileId,
      projects: [...scopes.projects].map(([projectId, profileId]) => ({ projectId, profileId })),
    })),
    Effect.mapError(storeError("read")),
  );

  const getThreadProfile = Effect.fn("InstructionProfiles.getThreadProfile")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* requireThread(threadId);
    const [threadChoice, scopes, profiles] = yield* Effect.all([
      repository.getThreadChoice(threadId),
      repository.getScopes,
      repository.list,
    ]).pipe(Effect.mapError(storeError("read")));
    const threadProfileId = threadChoice ?? null;
    const projectProfileId = scopes.projects.get(thread.projectId) ?? null;
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    const candidates: ReadonlyArray<readonly [InstructionProfileSource, string | null]> = [
      ["thread", threadProfileId],
      ["project", projectProfileId],
      ["default", scopes.defaultProfileId],
    ];
    const winner = candidates
      .map(([source, id]) => [source, id === null ? undefined : byId.get(id)] as const)
      .find(([, profile]) => profile !== undefined);
    return {
      threadId,
      threadProfileId,
      projectProfileId,
      defaultProfileId: scopes.defaultProfileId,
      source: winner?.[0] ?? "none",
      ...(winner?.[1] === undefined ? {} : { profile: winner[1] }),
    } satisfies ThreadInstructionProfile;
  });

  const instanceConfig = Effect.fn("InstructionProfiles.instanceConfig")(function* (
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => undefined));
    const configured: ProviderInstanceConfig | undefined = settings?.providerInstances[instanceId];
    return configured ?? { driver };
  });

  /** Unreadable config means no names, so no MCP key is ever emitted on a guess. */
  const codexConfigMcpServers = Effect.fn("InstructionProfiles.codexConfigMcpServers")(
    function* (instanceId: ProviderInstanceId, driver: ProviderDriverKind) {
      const home = yield* resolveAgentHarnessHome(
        "codex",
        yield* instanceConfig(instanceId, driver),
      );
      if (home === undefined) return [];
      const text = yield* fileSystem.readFileString(path.join(home, "config.toml"));
      return parseCodexConfigMcpServerNames(text);
    },
    (effect) =>
      effect.pipe(
        Effect.provideService(Path.Path, path),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.catchCause(() => Effect.succeed<ReadonlyArray<string>>([])),
      ),
  );

  return InstructionProfiles.of({
    list: repository.list.pipe(
      Effect.map((profiles) => ({ profiles })),
      Effect.mapError(storeError("read")),
    ),
    save: Effect.fn("InstructionProfiles.save")(function* (input) {
      if (input.id !== undefined) yield* requireProfile(input.id);
      const id = input.id ?? (yield* randomUuidV4);
      return yield* repository
        .save({
          id,
          name: input.name,
          description: input.description ?? "",
          globalInstructions: input.globalInstructions ?? "",
          items: input.items,
          now: yield* now,
        })
        .pipe(Effect.mapError(storeError("saved")));
    }),
    remove: Effect.fn("InstructionProfiles.remove")(function* (id) {
      yield* requireProfile(id);
      yield* repository
        .remove(id)
        .pipe(Effect.ensuring(choicesChanged), Effect.mapError(storeError("deleted")));
    }),
    getThreadProfile,
    setThreadProfile: Effect.fn("InstructionProfiles.setThreadProfile")(function* (input) {
      yield* requireThread(input.threadId);
      if (input.profileId !== null) yield* requireProfile(input.profileId);
      yield* repository
        .setThreadChoice({ threadId: input.threadId, profileId: input.profileId, now: yield* now })
        .pipe(Effect.ensuring(choicesChanged), Effect.mapError(storeError("saved")));
      return yield* getThreadProfile(input.threadId);
    }),
    getDefaults,
    setDefault: Effect.fn("InstructionProfiles.setDefault")(function* (input) {
      if (input.profileId !== null) yield* requireProfile(input.profileId);
      yield* repository
        .setScope({ projectId: null, profileId: input.profileId, now: yield* now })
        .pipe(Effect.ensuring(choicesChanged), Effect.mapError(storeError("saved")));
      return yield* getDefaults;
    }),
    setProject: Effect.fn("InstructionProfiles.setProject")(function* (input) {
      if (input.profileId !== null) yield* requireProfile(input.profileId);
      yield* repository
        .setScope({ projectId: input.projectId, profileId: input.profileId, now: yield* now })
        .pipe(Effect.ensuring(choicesChanged), Effect.mapError(storeError("saved")));
      return yield* getDefaults;
    }),
    support: { drivers: instructionProfileSupportTable() },
    launchFor: Effect.fn("InstructionProfiles.launchFor")(function* (input) {
      if (!(yield* hasAnyChoice)) return undefined;
      const { profile } = yield* getThreadProfile(input.threadId);
      if (profile === undefined) return undefined;
      const context =
        input.driver === "codex"
          ? { codexConfigMcpServers: yield* codexConfigMcpServers(input.instanceId, input.driver) }
          : {};
      return {
        profileId: profile.id,
        profileName: profile.name,
        plan: planInstructionProfile(input.driver, profile, context),
      } satisfies InstructionProfileLaunch;
    }),
    recordLaunch: Effect.fn("InstructionProfiles.recordLaunch")(function* (input) {
      if (input.launch === undefined) {
        yield* repository
          .recordNoProfile({ threadId: input.threadId, driver: input.driver, now: yield* now })
          .pipe(Effect.mapError(storeError("recorded")));
        return;
      }
      yield* repository
        .recordApplication({
          threadId: input.threadId,
          profileId: input.launch.profileId,
          profileName: input.launch.profileName,
          driver: input.driver,
          effects: input.launch.plan.effects,
          now: yield* now,
        })
        .pipe(Effect.mapError(storeError("recorded")));
    }),
  });
});

export const layer = Layer.effect(InstructionProfiles, make);
