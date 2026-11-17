import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type InstructionProfileItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as AgentInputStore from "../agentInput/AgentInputStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as InstructionProfilesRepository from "../persistence/InstructionProfiles.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as InstructionProfiles from "./InstructionProfiles.ts";

const thread = ThreadId.make("thread-1");
const otherThread = ThreadId.make("thread-2");
const missingThread = ThreadId.make("thread-missing");
const project = ProjectId.make("project-1");

const findThread = (threadId: ThreadId) =>
  Effect.succeed(
    threadId === missingThread ? null : ({ id: threadId, projectId: project } as never),
  );

const serviceLayer = (codexHome: string) =>
  InstructionProfiles.layer.pipe(
    Layer.provideMerge(InstructionProfilesRepository.layer),
    Layer.provideMerge(AgentInputStore.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({ findThread }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            providerInstances: { codex: { driver: "codex", config: { homePath: codexHome } } },
          } as never),
        }),
      ),
    ),
  );

const withService = <A, E>(
  use: Effect.Effect<
    A,
    E,
    InstructionProfiles.InstructionProfiles | AgentInputStore.AgentInputStore | SqlClient.SqlClient
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "instruction-profiles-" });
    yield* fileSystem.writeFileString(
      path.join(home, "config.toml"),
      '[mcp_servers.github]\ncommand = "gh"\n',
    );
    return yield* use.pipe(Effect.provide(serviceLayer(home)));
  }).pipe(Effect.scoped);

const item = (
  kind: InstructionProfileItem["kind"],
  name: string,
  enabled: boolean,
): InstructionProfileItem => ({ kind, name, enabled });

it.layer(Layer.mergeAll(NodeServices.layer, SqlitePersistence.layerMemory))(
  "InstructionProfiles",
  (it) => {
    it.effect("creates, replaces and deletes profiles", () =>
      withService(
        Effect.gen(function* () {
          const service = yield* InstructionProfiles.InstructionProfiles;
          const created = yield* service.save({
            name: "Lean",
            items: [item("skill", "pdf", false), item("skill", "*", true)],
          });
          expect(created.description).toBe("");
          expect(created.items).toEqual([item("skill", "*", true), item("skill", "pdf", false)]);

          const replaced = yield* service.save({
            id: created.id,
            name: "Lean 2",
            globalInstructions: "Be brief.",
            items: [item("agent", "*", false)],
          });
          expect(replaced.createdAt).toBe(created.createdAt);
          expect(replaced.items).toEqual([item("agent", "*", false)]);
          expect((yield* service.list).profiles.map((profile) => profile.name)).toEqual(["Lean 2"]);

          const unknown = yield* service
            .save({ id: "nope", name: "X", items: [] })
            .pipe(Effect.flip);
          expect(unknown._tag).toBe("InstructionProfileNotFoundError");

          yield* service.remove(created.id);
          expect((yield* service.list).profiles).toEqual([]);
          expect((yield* service.remove(created.id).pipe(Effect.flip))._tag).toBe(
            "InstructionProfileNotFoundError",
          );
        }),
      ),
    );

    it.effect("resolves thread, then project, then default, then none", () =>
      withService(
        Effect.gen(function* () {
          const service = yield* InstructionProfiles.InstructionProfiles;
          const a = yield* service.save({ name: "A", items: [] });
          const b = yield* service.save({ name: "B", items: [] });
          const c = yield* service.save({ name: "C", items: [] });

          expect((yield* service.getThreadProfile(thread)).source).toBe("none");
          yield* service.setDefault({ profileId: a.id });
          expect((yield* service.getThreadProfile(thread)).profile?.name).toBe("A");
          const defaults = yield* service.setProject({ projectId: project, profileId: b.id });
          expect(defaults).toEqual({
            defaultProfileId: a.id,
            projects: [{ projectId: project, profileId: b.id }],
          });
          const viaProject = yield* service.getThreadProfile(thread);
          expect([viaProject.source, viaProject.profile?.name]).toEqual(["project", "B"]);

          const viaThread = yield* service.setThreadProfile({ threadId: thread, profileId: c.id });
          expect(viaThread).toMatchObject({
            source: "thread",
            threadProfileId: c.id,
            projectProfileId: b.id,
            defaultProfileId: a.id,
          });
          expect((yield* service.getThreadProfile(otherThread)).source).toBe("project");

          // Deleting a chosen profile clears the choice instead of leaving a dangling id.
          yield* service.remove(c.id);
          const afterDelete = yield* service.getThreadProfile(thread);
          expect([afterDelete.source, afterDelete.threadProfileId]).toEqual(["project", null]);

          yield* service.setThreadProfile({ threadId: thread, profileId: a.id });
          yield* service.setThreadProfile({ threadId: thread, profileId: null });
          expect((yield* service.getThreadProfile(thread)).source).toBe("project");
          yield* service.setProject({ projectId: project, profileId: null });
          yield* service.setDefault({ profileId: null });
          expect((yield* service.getThreadProfile(thread)).source).toBe("none");

          const missing = yield* service.getThreadProfile(missingThread).pipe(Effect.flip);
          expect(missing).toMatchObject({ missing: "thread" });
          const badProfile = yield* service
            .setThreadProfile({ threadId: thread, profileId: "nope" })
            .pipe(Effect.flip);
          expect(badProfile).toMatchObject({ missing: "profile" });
        }),
      ),
    );

    it.effect("plans Codex with config.toml servers and records what was applied", () =>
      withService(
        Effect.gen(function* () {
          const service = yield* InstructionProfiles.InstructionProfiles;
          const store = yield* AgentInputStore.AgentInputStore;
          const driver = ProviderDriverKind.make("codex");
          expect(
            yield* service.launchFor({
              threadId: thread,
              driver,
              instanceId: ProviderInstanceId.make("codex"),
            }),
          ).toBeUndefined();

          const profile = yield* service.save({
            name: "Quiet",
            globalInstructions: "Be brief.",
            items: [item("mcpServer", "github", false), item("mcpServer", "plugin", false)],
          });
          yield* service.setThreadProfile({ threadId: thread, profileId: profile.id });
          const launch = yield* service.launchFor({
            threadId: thread,
            driver,
            instanceId: ProviderInstanceId.make("codex"),
          });
          expect(launch?.plan.codex?.config).toEqual({ "mcp_servers.github.enabled": false });
          expect(launch?.plan.effects.map((effect) => effect.result)).toEqual([
            "applied",
            "applied",
            "not-supported",
          ]);

          yield* service.recordLaunch({ threadId: thread, driver, launch: launch! });
          const use = yield* store.latestProfileUse(thread);
          expect(use).toMatchObject({ profileId: profile.id, profileName: "Quiet", driver });
          expect(use?.applied).toEqual(launch?.plan.effects);
          expect(use?.effects.map((effect) => [effect.toggle, effect.state])).toEqual([
            ["globalInstructions", "applied"],
            ["mcpServer", "applied"],
            ["mcpServer", "not-supported"],
          ]);

          // A launch with no profile hides the last one; a thread that never had one gets no row.
          yield* service.recordLaunch({ threadId: thread, driver, launch: undefined });
          expect(yield* store.latestProfileUse(thread)).toBeUndefined();
          yield* service.recordLaunch({ threadId: otherThread, driver, launch: undefined });
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly threadId: string; readonly profileId: string }>`
            SELECT thread_id AS "threadId", profile_id AS "profileId"
            FROM instruction_profile_applications ORDER BY id
          `;
          expect(rows.map((row) => [row.threadId, row.profileId])).toEqual([
            [thread, profile.id],
            [thread, ""],
          ]);
          yield* service.recordLaunch({ threadId: thread, driver, launch: undefined });
          expect((yield* sql`SELECT id FROM instruction_profile_applications`).length).toBe(2);
          yield* service.recordLaunch({ threadId: thread, driver, launch: launch! });
          expect((yield* store.latestProfileUse(thread))?.profileName).toBe("Quiet");
        }),
      ),
    );
  },
);
