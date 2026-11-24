// @effect-diagnostics nodeBuiltinImport:off -- Native junction creation matches the shared home builder on Windows.
import * as NodeFSP from "node:fs/promises";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { withSessionInputIdentity } from "./sessionIdentity.ts";
import type { ServerProvider } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { AntigravityProfile } from "../../provider/antigravityAuthSupport.ts";
import { discoverAntigravitySkills } from "../../provider/Drivers/AntigravitySkills.ts";
import {
  antigravityHooksConfig,
  antigravityMcpConfig,
  antigravityOwnedEntries,
  antigravityPluginConfig,
} from "./antigravityProfile.ts";
import { ignoreProjectWorkspace } from "./projectShadow.ts";
import type { SkillSetThread } from "./resolver.ts";
import * as SkillSets from "./runtime.ts";

const encodeSkillsConfig = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      entries: Schema.Array(Schema.Struct({ path: Schema.String })),
    }),
  ),
);
class AntigravityProfileLinkError extends Schema.TaggedError<AntigravityProfileLinkError>()(
  "AntigravityProfileLinkError",
  { cause: Schema.Defect() },
) {}

export const resolveAntigravitySkillSetProfile = Effect.fn("resolveAntigravitySkillSetProfile")(
  function* (
    service: SkillSets.SkillSets["Service"],
    instanceId: string,
    profileDirectory: string,
    thread: SkillSetThread,
    userHome?: string,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    return yield* Effect.gen(function* () {
      // The normal profile owns login and history; set profiles only link to that private storage.
      yield* fs.makeDirectory(profileDirectory, { recursive: true });
      const resolved = yield* service.resolveHome(
        "antigravity",
        {
          instanceId,
          realHome: profileDirectory,
          skillsEntry: "config/skills",
          privateEntries: ["config", "antigravity-cli"],
          owned: antigravityOwnedEntries,
        },
        thread,
      );
      if (!resolved) return undefined;
      const config = path.join(resolved.homePath, "config");
      yield* fs.makeDirectory(config, { recursive: true });
      const generated = [
        "skills.json",
        "plugins.json",
        "config.json",
        "hooks.json",
        "mcp_config.json",
      ];
      for (const entry of generated) {
        const file = path.join(config, entry);
        const info = yield* fs
          .lstat(file)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
        // Links and plugins.json copies come from older builds of this home.
        if (info?.type === "SymbolicLink" || (info && entry === "plugins.json"))
          yield* fs.remove(file);
      }
      // agy skips Windows junctions during discovery; explicit canonical targets keep linked sets visible.
      yield* writeFileStringAtomically({
        filePath: path.join(config, "skills.json"),
        contents: encodeSkillsConfig({
          entries: resolved.skills.map((skill) => ({
            path: path.relative(config, skill.targetPath).replaceAll("\\", "/"),
          })),
        }),
      });
      const profile = resolved.profile;
      if (!profile) return resolved;
      // Plugin files stay where they were installed: the instance first, else the real home.
      const pluginSources = [
        path.join(profileDirectory, "config", "plugins"),
        ...(userHome ? [path.join(userHome, ".gemini", "config", "plugins")] : []),
      ];
      let pluginSource: string | undefined;
      for (const candidate of pluginSources)
        if (pluginSource === undefined && (yield* fs.exists(candidate))) pluginSource = candidate;
      const pluginLink = path.join(config, "plugins");
      const linked = yield* fs.readLink(pluginLink).pipe(
        Effect.map((value): string | undefined => path.resolve(config, value)),
        Effect.orElseSucceed(() => undefined),
      );
      if (linked !== undefined && linked !== pluginSource) yield* fs.remove(pluginLink);
      if (pluginSource !== undefined && linked !== pluginSource)
        yield* Effect.tryPromise({
          try: () =>
            NodeFSP.symlink(pluginSource, pluginLink, platform === "win32" ? "junction" : "dir"),
          catch: (cause) => new AntigravityProfileLinkError({ cause }),
        });
      const pluginFolders = pluginSource
        ? (yield* fs.readDirectory(pluginSource)).filter((name) => !name.startsWith("."))
        : [];
      const instanceConfig = yield* fs
        .readFileString(path.join(profileDirectory, "config", "config.json"))
        .pipe(Effect.orElseSucceed((): string | undefined => undefined));
      const hooks = antigravityHooksConfig(profile);
      for (const [entry, contents] of [
        [
          "config.json",
          antigravityPluginConfig({ instanceConfig, pluginFolders, enabled: profile.plugins }),
        ],
        ["mcp_config.json", antigravityMcpConfig(profile.mcpServers)],
        ...(hooks === undefined ? [] : [["hooks.json", hooks] as const]),
      ] as const)
        yield* writeFileStringAtomically({ filePath: path.join(config, entry), contents });
      if (hooks === undefined) yield* fs.remove(path.join(config, "hooks.json"), { force: true });
      return resolved;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Could not prepare Antigravity skill-set profile; using provider home",
          cause,
        ).pipe(Effect.as(undefined)),
      ),
    );
  },
);

export const applyAntigravitySkillSetProfile = Effect.fn("applyAntigravitySkillSetProfile")(
  function* (
    service: SkillSets.SkillSets["Service"],
    instanceId: string,
    profile: AntigravityProfile,
    thread: SkillSetThread,
    userHome?: string,
  ) {
    const resolved = yield* resolveAntigravitySkillSetProfile(
      service,
      instanceId,
      profile.geminiHome,
      thread,
      userHome,
    );
    return resolved ? { ...profile, geminiHome: resolved.homePath } : profile;
  },
);

export const antigravitySkillSetSnapshot = Effect.fn("antigravitySkillSetSnapshot")(
  function* (input: {
    readonly service: SkillSets.SkillSets["Service"];
    readonly instanceId: string;
    readonly profileDirectory: string;
    readonly userHome: string;
    readonly cwd: string;
    readonly thread?: SkillSetThread | undefined;
    readonly snapshot: (
      cwd: string,
      skills?: ServerProvider["skills"],
    ) => Effect.Effect<ServerProvider>;
  }) {
    const resolved = yield* resolveAntigravitySkillSetProfile(
      input.service,
      input.instanceId,
      input.profileDirectory,
      input.thread ?? {},
      input.userHome,
    );
    if (!resolved)
      return yield* discoverAntigravitySkills(input).pipe(
        Effect.flatMap((skills) => input.snapshot(input.cwd, skills)),
      );
    const snapshot = yield* input.snapshot(input.cwd);
    const discovered = yield* discoverAntigravitySkills({
      ...input,
      profileDirectory: resolved.homePath,
      userGeminiHome: resolved.homePath,
    });
    const selected = new Map(resolved.skills.map((skill) => [skill.name, skill.commandOnly]));
    const path = yield* Path.Path;
    const names = new Set(discovered.map((skill) => skill.name));
    const skills = [
      ...discovered.map((skill) =>
        selected.has(skill.name) && skill.scope === "user"
          ? { ...skill, userInvocationOnly: selected.get(skill.name) }
          : skill,
      ),
      ...resolved.skills
        .filter((skill) => !names.has(skill.name))
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: path.join(skill.targetPath, "SKILL.md"),
          scope: "user",
          enabled: true,
          userInvocationOnly: skill.commandOnly,
        })),
    ].sort((left, right) => left.name.localeCompare(right.name));
    const original = yield* discoverAntigravitySkills(input);
    const statuses = yield* input.service.statuses;
    const skillNames = new Set(
      [...original, ...snapshot.skills, ...statuses.flatMap((status) => status.skills)].map(
        (skill) => skill.name,
      ),
    );
    const slashCommands = [
      ...snapshot.slashCommands.filter((command) => !skillNames.has(command.name)),
      ...skills.map((skill) => ({
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
      })),
    ];
    return { ...snapshot, skills, slashCommands };
  },
);

export const makeAntigravitySkillSetIntegration = Effect.fn("makeAntigravitySkillSetIntegration")(
  function* (instanceId: string, profileDirectory: string, userHome: string) {
    const service = yield* SkillSets.SkillSets;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    const identity = (thread: SkillSetThread) =>
      provide(
        resolveAntigravitySkillSetProfile(service, instanceId, profileDirectory, thread, userHome),
      ).pipe(
        Effect.map((resolved) =>
          resolved
            ? [
                resolved.homePath,
                resolved.profile?.contentHash ?? "",
                ...resolved.skills.map((skill) => `${skill.name}:${skill.targetPath}`),
              ].join("\0")
            : undefined,
        ),
      );
    /** Lead decision 18: with "ignore project instructions" on, agy runs in a mirror of the project. */
    const workspace = <
      I extends {
        readonly cwd: string;
        readonly skillSetId?: string | null;
        readonly threadId?: string;
        readonly processEnvironment?: NodeJS.ProcessEnv;
      },
    >(
      input: I,
    ) =>
      provide(
        resolveAntigravitySkillSetProfile(
          service,
          instanceId,
          profileDirectory,
          { skillSetId: input.skillSetId, threadId: input.threadId },
          userHome,
        ),
      ).pipe(
        Effect.flatMap((resolved) =>
          resolved?.profile?.ignoreProjectInstructions
            ? Effect.promise(() =>
                ignoreProjectWorkspace(
                  input.cwd,
                  path.join(path.dirname(path.dirname(resolved.homePath)), "workspaces"),
                ),
              ).pipe(
                Effect.tap((mirror) =>
                  mirror.created.length
                    ? Effect.logWarning(
                        "Files made inside the project mirror did not reach the project",
                        { files: mirror.created },
                      )
                    : Effect.void,
                ),
                Effect.map((mirror): I => ({
                  ...input,
                  cwd: mirror.cwd,
                  processEnvironment: { ...input.processEnvironment, ...mirror.environment },
                })),
              )
            : Effect.succeed(input),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Could not hide project instructions for Antigravity; using the project folder",
            cause,
          ).pipe(Effect.as(input)),
        ),
      );
    return {
      sessionInputIdentity: identity,
      workspace,
      applyProfile: (profile: AntigravityProfile, thread: SkillSetThread) =>
        provide(applyAntigravitySkillSetProfile(service, instanceId, profile, thread, userHome)),
      snapshot: (
        cwd: string,
        thread: SkillSetThread | undefined,
        snapshot: Parameters<typeof antigravitySkillSetSnapshot>[0]["snapshot"],
      ) =>
        provide(
          antigravitySkillSetSnapshot({
            service,
            instanceId,
            profileDirectory,
            userHome,
            cwd,
            thread,
            snapshot,
          }),
        ),
      wrapAdapter: (adapter: ProviderAdapter.ProviderAdapterV2["Service"]) => ({
        ...adapter,
        openSession: Effect.fn("AntigravitySkillSets.openSession")(function* (
          input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
        ) {
          const runtime = yield* adapter.openSession(input);
          return withSessionInputIdentity(runtime, identity);
        }),
      }),
    };
  },
);
