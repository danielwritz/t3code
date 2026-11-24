import { afterEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it.effect("isolates the profile and disables updates for an embedded personal identity", () =>
  Effect.gen(function* () {
    vi.stubGlobal("__T3CODE_PERSONAL_DESKTOP_IDENTITY__", {
      productName: "Test Fork",
      appId: "org.example.fork",
      packageName: "test-fork",
      userDataDirectory: "test-fork-profile",
      scheme: "test-fork",
      disableAutoUpdate: true,
    });
    const { resolveUserDataPath } = yield* Effect.promise(
      () => import("../app/DesktopUserData.ts"),
    );
    const result = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      isDevelopment: false,
      platform: "win32",
    }).pipe(
      Effect.provide([Path.layer, FileSystem.layerNoop({ exists: () => Effect.succeed(false) })]),
    );
    expect(result.replaceAll("\\", "/")).toBe("/profiles/test-fork-profile");
    const { DesktopConfig, layerTest } = yield* Effect.promise(
      () => import("../app/DesktopConfig.ts"),
    );
    expect(
      (yield* DesktopConfig.pipe(
        Effect.provide(layerTest({ T3CODE_DISABLE_AUTO_UPDATE: "false" })),
      )).disableAutoUpdate,
    ).toBe(true);
  }),
);

it.effect("keeps the upstream profile without embedded personal configuration", () =>
  Effect.gen(function* () {
    const { resolveUserDataPath } = yield* Effect.promise(
      () => import("../app/DesktopUserData.ts"),
    );
    expect(
      yield* resolveUserDataPath({
        appDataDirectory: "/profiles",
        isDevelopment: false,
        platform: "linux",
      }).pipe(Effect.provide([Path.layer, FileSystem.layerNoop({})])),
    ).toBe("/profiles/t3code-v2");
  }),
);

it("uses the requested home userdata in production and development", async () => {
  const { resolveDesktopBaseDir, resolveDesktopStateDir } =
    await import("../app/DesktopStatePaths.ts");
  for (const isDevelopment of [false, true]) {
    const input = {
      homeDirectory: "/user",
      joinPath: (...parts: string[]) => parts.join("/"),
      t3Home: Option.some("/copied-home"),
      isDevelopment,
    };
    expect(resolveDesktopStateDir({ ...input, baseDir: resolveDesktopBaseDir(input) })).toBe(
      "/copied-home/userdata",
    );
  }
});
