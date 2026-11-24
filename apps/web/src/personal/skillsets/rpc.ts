import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { requestGuarded } from "@t3tools/client-runtime/rpc";
import {
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type ServerProvider,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "~/connection/runtime";

export const skillSetStatuses = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "personal:skill-sets:statuses",
  tag: "skillSets.subscribe",
});
export const syncSkillSet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal:skill-sets:sync",
  tag: "skillSets.sync",
});
export const pickSkillSet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal:skill-sets:pick",
  tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
});
export const threadSkillSetProviders = Atom.family((_key: string) =>
  Atom.make<readonly ServerProvider[] | null>(null),
);
export const refreshThreadSkillSetProviders = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal:skill-sets:thread-menu",
  tag: WS_METHODS.serverRefreshProviders,
  execute: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly catalogKey: string;
  }) =>
    requestGuarded(WS_METHODS.serverRefreshProviders, {
      instanceId: input.instanceId,
      cwd: input.cwd,
      threadId: input.threadId,
      workspaceSnapshotsOnDemand: true,
    }),
  onSuccess: ({ input }, registry, result) =>
    Effect.sync(() => registry.set(threadSkillSetProviders(input.catalogKey), result.providers)),
});
