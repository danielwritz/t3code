import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeHarness } from "../updates/updatesTestHarness.ts";
import { DesktopUpdates } from "../updates/DesktopUpdates.ts";

vi.mock("./identity.ts", () => ({
  personalDesktopIdentity: {
    productName: "Test Fork",
    appId: "org.example.fork",
    disableAutoUpdate: true,
  },
}));

it.effect("makes no updater request even when the environment tries to enable updates", () => {
  const harness = makeHarness({ env: { T3CODE_DISABLE_AUTO_UPDATE: "false" } });
  return Effect.gen(function* () {
    const updates = yield* DesktopUpdates;
    yield* updates.configure;
    yield* updates.check("manual");
    expect((yield* updates.getState).status).toBe("disabled");
    expect(harness.checkCount()).toBe(0);
  }).pipe(Effect.provide(harness.layer), Effect.scoped);
});
