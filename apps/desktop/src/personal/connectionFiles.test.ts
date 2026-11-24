import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { afterEach, expect, vi } from "vite-plus/test";

import type * as SafeStorageTypes from "../electron/ElectronSafeStorage.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const otherAppCatalog = '{"version":1,"encryptedCatalog":"b3RoZXItcHJvZmlsZS1rZXk="}\n';
const otherAppSavedEnvironments =
  '{"version":1,"records":[{"environmentId":"other","label":"Other","httpBaseUrl":"https://other.example.com/","wsBaseUrl":"wss://other.example.com/","createdAt":"2026-06-01T00:00:00.000Z","lastConnectedAt":null,"encryptedBearerToken":"b3RoZXI="}]}\n';

const runStore = Effect.fn("test.runStore")(function* () {
  const { DesktopEnvironment, layer: environmentLayer } = yield* Effect.promise(
    () => import("../app/DesktopEnvironment.ts"),
  );
  const DesktopConfig = yield* Effect.promise(() => import("../app/DesktopConfig.ts"));
  const ElectronSafeStorage = yield* Effect.promise(
    () => import("../electron/ElectronSafeStorage.ts"),
  );
  const DesktopSavedEnvironments = yield* Effect.promise(
    () => import("../settings/DesktopSavedEnvironments.ts"),
  );
  const DesktopConnectionCatalogStore = yield* Effect.promise(
    () => import("../app/DesktopConnectionCatalogStore.ts"),
  );
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-connection-files-" });
  const stateDir = path.join(baseDir, "userdata");
  yield* fileSystem.makeDirectory(stateDir, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(stateDir, "connection-catalog.json"),
    otherAppCatalog,
  );
  yield* fileSystem.writeFileString(
    path.join(stateDir, "saved-environments.json"),
    otherAppSavedEnvironments,
  );

  // This profile can only decrypt what it encrypted itself, like a separate Chromium profile.
  const safeStorage = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(true),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`own:${value}`)),
    decryptString: (value) => {
      const decoded = textDecoder.decode(value);
      return decoded.startsWith("own:")
        ? Effect.succeed(decoded.slice("own:".length))
        : Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageDecryptError({
              cause: new Error("another profile's key"),
            }),
          );
    },
    selectedStorageBackend: Effect.succeedNone,
  } satisfies SafeStorageTypes.ElectronSafeStorage["Service"]);
  const environment = environmentLayer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "win32",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  const dependencies = Layer.mergeAll(
    environment,
    safeStorage,
    NodeServices.layer,
    NodeCrypto.layer,
  );
  const layer = DesktopConnectionCatalogStore.layer.pipe(
    Layer.provideMerge(DesktopSavedEnvironments.layer.pipe(Layer.provideMerge(dependencies))),
    Layer.provideMerge(dependencies),
  );

  return yield* Effect.gen(function* () {
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
    const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
    const env = yield* DesktopEnvironment;
    const read = yield* store.get.pipe(Effect.option);
    const saved = yield* store.set('{"schemaVersion":1,"targets":[]}');
    const registry = yield* savedEnvironments.getRegistry.pipe(Effect.option);
    return {
      read,
      saved,
      registry,
      registryName: path.basename(env.savedEnvironmentRegistryPath),
      files: (yield* fileSystem.readDirectory(stateDir)).toSorted(),
      catalog: yield* fileSystem.readFileString(path.join(stateDir, "connection-catalog.json")),
      savedEnvironments: yield* fileSystem.readFileString(
        path.join(stateDir, "saved-environments.json"),
      ),
    };
  }).pipe(Effect.provide(layer));
});

it.effect("keeps the personal app away from the other app's encrypted connection files", () =>
  Effect.gen(function* () {
    vi.stubGlobal("__T3CODE_PERSONAL_DESKTOP_IDENTITY__", {
      productName: "Test Fork",
      appId: "org.example.fork",
      packageName: "test-fork",
      userDataDirectory: "test-fork-profile",
      scheme: "test-fork",
      iconSource: "icon.png",
      disableAutoUpdate: true,
    });
    const result = yield* runStore();

    expect(result.catalog).toBe(otherAppCatalog);
    expect(result.savedEnvironments).toBe(otherAppSavedEnvironments);
    expect(result.registryName).toBe("saved-environments.test-fork.json");
    expect(result.read).toEqual(Option.some(Option.none()));
    expect(result.saved).toBe(true);
    expect(Option.map(result.registry, (records) => records.length)).toEqual(Option.some(0));
    expect(result.files).toEqual([
      "connection-catalog.json",
      "connection-catalog.test-fork.json",
      "saved-environments.json",
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps the upstream connection file names without a personal identity", () =>
  Effect.gen(function* () {
    const result = yield* runStore();

    expect(result.registryName).toBe("saved-environments.json");
    expect(result.files).toContain("connection-catalog.json");
    expect(result.files).not.toContain("connection-catalog.test-fork.json");
    expect(result.catalog).not.toBe(otherAppCatalog);
  }).pipe(Effect.provide(NodeServices.layer)),
);
