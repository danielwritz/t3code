import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type AuthSessionState,
  type InstructionProfile,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE, BearerConnectionTarget } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createInstructionProfileEnvironmentAtoms } from "./instructionProfiles.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_ID = ThreadId.make("thread-1");
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);

const LEAN: InstructionProfile = {
  id: "lean",
  name: "Lean",
  description: "",
  globalInstructions: "",
  items: [],
  createdAt: "2026-11-17T10:00:00.000Z",
  updatedAt: "2026-11-17T10:00:00.000Z",
};

const makeHarness = Effect.fn("TestInstructionProfiles.makeHarness")(function* () {
  const server = { defaultProfileId: "lean" as string | null, threadReads: 0 };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Test",
      connectionId: "test",
    }),
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [ORCHESTRATION_V2_WS_METHODS.getThreadInstructionProfile]: () =>
            Effect.sync(() => {
              server.threadReads += 1;
              return {
                threadId: THREAD_ID,
                threadProfileId: null,
                projectProfileId: null,
                defaultProfileId: server.defaultProfileId,
                source: server.defaultProfileId === null ? "none" : "default",
                ...(server.defaultProfileId === null ? {} : { profile: LEAN }),
              };
            }),
          [ORCHESTRATION_V2_WS_METHODS.setDefaultInstructionProfile]: (input: {
            profileId: string | null;
          }) =>
            Effect.sync(() => {
              server.defaultProfileId = input.profileId;
            }),
          [ORCHESTRATION_V2_WS_METHODS.deleteInstructionProfile]: () =>
            Effect.sync(() => {
              server.defaultProfileId = null;
            }),
          [ORCHESTRATION_V2_WS_METHODS.listInstructionProfiles]: () =>
            Effect.succeed({ profiles: server.defaultProfileId === null ? [] : [LEAN] }),
          [ORCHESTRATION_V2_WS_METHODS.getInstructionProfileDefaults]: () =>
            Effect.sync(() => ({ defaultProfileId: server.defaultProfileId, projects: [] })),
        },
      } as unknown as RpcSession),
    ),
    state: yield* SubscriptionRef.make({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected" as const,
    }),
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
      run: (_environmentId, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      followStream: (_environmentId, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
  );
  const atoms = createInstructionProfileEnvironmentAtoms(runtime);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.set(
    sessions(ENVIRONMENT_ID),
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthSettingsWriteScope, AuthOrchestrationOperateScope],
      permissions: [AuthSettingsWriteScope, AuthOrchestrationOperateScope],
    }),
  );
  return { atoms, registry, server };
});

describe("instruction profile writes", () => {
  it.effect("refresh a mounted thread's profile when the default or a profile changes", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const thread = h.atoms.threadProfile({
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      h.registry.mount(thread);
      const read = () => AtomRegistry.getResult(h.registry, thread, { suspendOnWaiting: true });
      expect((yield* read()).profile?.name).toBe("Lean");

      yield* Effect.promise(() =>
        h.atoms.setDefault.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { profileId: null },
        }),
      );
      expect((yield* read()).source).toBe("none");

      yield* Effect.promise(() =>
        h.atoms.setDefault.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { profileId: "lean" },
        }),
      );
      expect((yield* read()).profile?.name).toBe("Lean");

      yield* Effect.promise(() =>
        h.atoms.remove.run(h.registry, { environmentId: ENVIRONMENT_ID, input: { id: "lean" } }),
      );
      expect((yield* read()).profile).toBeUndefined();
      expect(h.server.threadReads).toBe(4);
    }),
  );
});
