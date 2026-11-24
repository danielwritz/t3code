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
        },
        thread,
      );
      if (!resolved) return undefined;
      const config = path.join(resolved.homePath, "config");
      yield* fs.makeDirectory(config, { recursive: true });
      for (const entry of ["skills.json", "plugins.json", "config.json"]) {
        const file = path.join(config, entry);
        const info = yield* fs
          .lstat(file)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
        if (info?.type === "SymbolicLink") yield* fs.remove(file);
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
      for (const entry of ["plugins", "plugins.json", "config.json"]) {
        const target = path.join(profileDirectory, "config", entry);
        const destination = path.join(config, entry);
        if (!(yield* fs.exists(target))) continue;
        const info = yield* fs.stat(target);
        if (info.type === "Directory") {
          if (!(yield* fs.exists(destination)))
            yield* Effect.tryPromise({
              try: () =>
                NodeFSP.symlink(target, destination, platform === "win32" ? "junction" : "dir"),
              catch: (cause) => new AntigravityProfileLinkError({ cause }),
            });
        } else
          yield* writeFileStringAtomically({
            filePath: destination,
            contents: yield* fs.readFileString(target),
          });
      }
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
  ) {
    const resolved = yield* resolveAntigravitySkillSetProfile(
      service,
      instanceId,
      profile.geminiHome,
      thread,
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
    const skills = discovered.map((skill) =>
      selected.has(skill.name) && skill.scope === "user"
        ? { ...skill, userInvocationOnly: selected.get(skill.name) }
        : skill,
    );
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
        resolveAntigravitySkillSetProfile(service, instanceId, profileDirectory, thread),
      ).pipe(
        Effect.map((resolved) =>
          resolved
            ? [
                resolved.homePath,
                ...resolved.skills.map((skill) => `${skill.name}:${skill.targetPath}`),
              ].join("\0")
            : undefined,
        ),
      );
    return {
      sessionInputIdentity: identity,
      applyProfile: (profile: AntigravityProfile, thread: SkillSetThread) =>
        provide(applyAntigravitySkillSetProfile(service, instanceId, profile, thread)),
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
