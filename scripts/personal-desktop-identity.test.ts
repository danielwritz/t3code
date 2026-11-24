import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import skipPreparedCache from "./personal-desktop-after-pack.ts";
import {
  readPersonalDesktopIdentity,
  personalDesktopIdentity,
} from "./lib/personal-desktop-identity.ts";
import { resolvePersonalDesktopAfterPack } from "./lib/personal-desktop-packaging.ts";

vi.mock("./lib/personal-desktop-identity.ts", async (original) => ({
  ...(await original<typeof import("./lib/personal-desktop-identity.ts")>()),
  personalDesktopIdentity: {
    productName: "Test Fork",
    appId: "org.example.fork",
    packageName: "test-fork",
    userDataDirectory: "test-profile",
    scheme: "test-fork",
    iconSource: "assets/test.png",
    disableAutoUpdate: true,
    prepareServerCompileCache: false,
  },
}));

it.effect(
  "keeps personal installer identity and removes feeds even with a release repository",
  () =>
    Effect.gen(function* () {
      vi.stubEnv("GITHUB_REPOSITORY", "example/releases");
      try {
        const { createBuildConfig } = yield* Effect.promise(
          () => import("./build-desktop-artifact.ts"),
        );
        const config = yield* createBuildConfig(
          "win",
          "nsis",
          "1.2.3-nightly.1",
          false,
          true,
          7777,
          undefined,
        );
        expect(config.appId).toBe("org.example.fork");
        expect(config.productName).toBe("Test Fork");
        expect(config.publish).toBeNull();
        expect(config.protocols).toBeUndefined();
        expect(String(config.afterPack).replaceAll("\\", "/")).toMatch(
          /\/scripts\/personal-desktop-after-pack\.ts$/,
        );
      } finally {
        vi.unstubAllEnvs();
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "omits prepared cache files while preserving the upstream hook without personal configuration",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "personal-after-pack-" });
      expect(resolvePersonalDesktopAfterPack("win", undefined)).toBe(
        "scripts/prepare-server-compile-cache.cjs",
      );
      expect(resolvePersonalDesktopAfterPack("linux", personalDesktopIdentity)).toBe(
        "scripts/prepare-server-compile-cache.cjs",
      );
      yield* Effect.promise(() => skipPreparedCache());
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps upstream behavior when the optional config file is absent and rejects incomplete identities",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "identity-test-" });
      const url = yield* path.toFileUrl(path.join(dir, "identity.json"));
      expect(readPersonalDesktopIdentity(url)).toBeUndefined();
      yield* fs.writeFileString(path.join(dir, "identity.json"), '{"productName":"test"}');
      expect(() => readPersonalDesktopIdentity(url)).toThrow();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
