import { ORCHESTRATION_V2_WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/reactivity";
import { Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Instruction profiles per environment: the saved profiles, the default and per-project choice,
 * each thread's choice, and which switches each driver has. Every write refreshes what it changed.
 */
export function createInstructionProfileEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  // Bumped by every write; mounted thread choices refetch, since any write can change them.
  const revision = Atom.family((_environmentId: string) => Atom.make(0).pipe(Atom.keepAlive));
  const profiles = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:instruction-profiles:list",
    tag: ORCHESTRATION_V2_WS_METHODS.listInstructionProfiles,
    staleTimeMs: 0,
  });
  const defaults = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:instruction-profiles:defaults",
    tag: ORCHESTRATION_V2_WS_METHODS.getInstructionProfileDefaults,
    staleTimeMs: 0,
  });
  const threadProfile = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:instruction-profiles:thread",
    tag: ORCHESTRATION_V2_WS_METHODS.getThreadInstructionProfile,
    staleTimeMs: 0,
    idleTtlMs: 0,
    refreshTrigger: ({ environmentId }) => revision(environmentId),
  });
  const support = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:instruction-profiles:support",
    tag: ORCHESTRATION_V2_WS_METHODS.getInstructionProfileSupport,
    staleTimeMs: Number.POSITIVE_INFINITY,
  });
  const refreshAll = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(profiles({ environmentId: target.environmentId, input: {} }));
      registry.refresh(defaults({ environmentId: target.environmentId, input: {} }));
      registry.update(revision(target.environmentId), (value) => value + 1);
    });
  const serialPerEnvironment = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    profiles,
    defaults,
    threadProfile,
    support,
    save: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:instruction-profiles:save",
      tag: ORCHESTRATION_V2_WS_METHODS.saveInstructionProfile,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSettled: refreshAll,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:instruction-profiles:delete",
      tag: ORCHESTRATION_V2_WS_METHODS.deleteInstructionProfile,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSettled: refreshAll,
    }),
    setDefault: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:instruction-profiles:set-default",
      tag: ORCHESTRATION_V2_WS_METHODS.setDefaultInstructionProfile,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSettled: refreshAll,
    }),
    setProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:instruction-profiles:set-project",
      tag: ORCHESTRATION_V2_WS_METHODS.setProjectInstructionProfile,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSettled: refreshAll,
    }),
    setThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:instruction-profiles:set-thread",
      tag: ORCHESTRATION_V2_WS_METHODS.setThreadInstructionProfile,
      onSettled: (target, registry) =>
        Effect.sync(() => registry.update(revision(target.environmentId), (value) => value + 1)),
    }),
  };
}
