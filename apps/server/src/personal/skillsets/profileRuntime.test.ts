// @effect-diagnostics nodeBuiltinImport:off -- A fake user home must exist before the layer reads it.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../../serverSettings.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as SkillSets from "./runtime.ts";

const fakeUser = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "profile-runtime-user-"));
NodeFS.mkdirSync(NodePath.join(fakeUser, ".claude"), { recursive: true });
NodeFS.writeFileSync(NodePath.join(fakeUser, ".claude", "CLAUDE.md"), "fake user rules");
NodeFS.writeFileSync(
  NodePath.join(fakeUser, ".claude.json"),
  JSON.stringify({ mcpServers: { calendar: { command: "node", env: { TOKEN: "s3cret" } } } }),
);
const settingsLayer = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(Layer.fresh(Sqlite.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "profile-runtime-" })),
  ),
);
const layerTest = SkillSets.layer.pipe(
  Layer.provideMerge(settingsLayer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provide(Layer.succeed(HostProcess.HomeDirectory, fakeUser)),
  Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
  Layer.provide(Layer.succeed(HostProcess.Environment, {})),
);

it.effect(
  "serves profiles, switches and the inventory over the RPC handlers and persists them",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const source = config.stateDir + "/gamma-profile";
        yield* fs.makeDirectory(source + "/skills/alpha", { recursive: true });
        yield* fs.writeFileString(source + "/skills/alpha/SKILL.md", "---\nname: alpha\n---\n");
        yield* fs.writeFileString(source + "/CLAUDE.md", "gamma rules");
        yield* fs.writeFileString(
          source + "/mcp.json",
          JSON.stringify({ mcpServers: { docs: { url: "https://docs.example/mcp" } } }),
        );
        yield* settings.updateSettings({
          skillSetsEnabled: true,
          defaultSkillSetId: "gamma",
          skillSets: {
            gamma: {
              name: "Gamma",
              source: { kind: "local", path: source },
              enabled: true,
              autoSync: false,
              disabledSkills: [],
            },
          },
        });
        const handlers = yield* SkillSets.skillSetRpcHandlers;
        yield* handlers["skillSets.sync"]({ id: "gamma" });
        const [listed] = yield* handlers["agentProfiles.list"]();
        expect(listed?.items.map((item) => item.id)).toEqual([
          "instructions:CLAUDE.md",
          "skill:alpha",
          "mcp:docs",
        ]);
        yield* handlers["agentProfiles.setItemEnabled"]({
          profileId: "gamma",
          itemId: "mcp:docs",
          enabled: false,
        });
        yield* handlers["agentProfiles.setIgnoreProject"]({ profileId: "gamma", ignore: true });
        yield* handlers["agentProfiles.setThreadIgnoreProject"]({
          threadId: "thread-7",
          ignore: false,
        });
        const saved = JSON.parse(
          yield* fs.readFileString(config.stateDir + "/skill-sets/state.json"),
        );
        expect(saved.skillSets.gamma).toMatchObject({
          disabledItems: ["mcp:docs"],
          ignoreProjectInstructions: true,
        });
        expect(
          (yield* handlers["agentProfiles.threadOptions"]({ threadId: "thread-7" }))
            .ignoreProjectInstructions,
        ).toBe(false);
        const forThread = yield* SkillSets.resolveAgentProfile("codex", { threadId: "thread-7" });
        const forOther = yield* SkillSets.resolveAgentProfile("codex", { threadId: "thread-8" });
        expect(forThread).toMatchObject({ profileId: "gamma", ignoreProjectInstructions: false });
        expect(forOther).toMatchObject({ ignoreProjectInstructions: true, mcpServers: {} });
        expect(forThread?.skills.map((skill) => skill.name)).toEqual(["alpha"]);

        const inventory = yield* handlers["agentProfiles.inventory"]();
        const claude = inventory.providers.find((entry) => entry.provider === "claude");
        expect(claude?.items.map((item) => item.id)).toEqual([
          "claude:instructions:CLAUDE.md",
          "claude:mcp:calendar",
        ]);
        expect(JSON.stringify(inventory)).not.toContain("s3cret");
        const created = yield* handlers["agentProfiles.createFromReferences"]({
          id: "mine",
          name: "Mine",
          references: ["claude:instructions:CLAUDE.md"],
        });
        expect(created.items.map((item) => item.id)).toEqual(["ref:claude:instructions:CLAUDE.md"]);
        const own = yield* SkillSets.resolveAgentProfile("claudeAgent", { skillSetId: "mine" });
        expect(own?.instructions?.text).toBe("fake user rules");
        const refused = yield* handlers["agentProfiles.setIgnoreProject"]({
          profileId: "absent",
          ignore: true,
        }).pipe(Effect.flip);
        expect(refused._tag).toBe("AgentProfileError");
      }),
    ).pipe(Effect.provide(layerTest)),
);
