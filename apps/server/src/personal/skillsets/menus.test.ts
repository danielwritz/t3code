import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import type {
  ProviderInstance,
  ProviderWorkspaceSnapshot,
} from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { skillSetMenuRefresh } from "./menus.ts";

it.effect(
  "refreshes attached native menus with the owner's current pick and leaves forks independent",
  () =>
    Effect.gen(function* () {
      const parentId = ThreadId.make("owner");
      const childId = ThreadId.make("child");
      let parentPick: string | null = "alpha";
      let native = true;
      const picks: Array<string | null | undefined> = [];
      const thread = (id: ThreadId) =>
        ({
          id,
          skillSetId: id === parentId ? parentPick : "beta",
          creationSource: native ? "provider" : "web",
          lineage: {
            parentThreadId: id === childId ? parentId : null,
            relationshipToParent: id === childId ? (native ? "subagent" : "fork") : null,
          },
        }) as OrchestrationV2AppThread;
      const refresh = yield* skillSetMenuRefresh.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: () =>
                Effect.succeed({
                  snapshotForCwd: (
                    _cwd: string,
                    context?: { readonly skillSetId?: string | null | undefined },
                  ) => {
                    picks.push(context?.skillSetId);
                    return Effect.succeed({
                      cwd: _cwd,
                      checkedAt: "2026-01-01T00:00:00.000Z",
                      skills: [],
                      slashCommands: [],
                    } as unknown as ProviderWorkspaceSnapshot);
                  },
                } as unknown as ProviderInstance),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadRecords: (id) =>
                Effect.succeed({ thread: thread(id) } as Effect.Success<
                  ReturnType<
                    ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"]
                  >
                >),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, skillSetsEnabled: true }),
            }),
          ),
        ),
      );
      const input = {
        instanceId: ProviderInstanceId.make("codex"),
        cwd: "/workspace",
        threadId: childId,
      };
      yield* refresh(input);
      parentPick = null;
      yield* refresh(input);
      native = false;
      yield* refresh(input);
      expect(picks).toEqual(["alpha", null, "beta"]);
    }),
);
