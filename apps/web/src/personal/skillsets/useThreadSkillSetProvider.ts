import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";
import { useAtomCommand } from "~/state/use-atom-command";
import { useSkillSetRegistry } from "./skillSetsStore";
import { threadSkillSetProviders, refreshThreadSkillSetProviders } from "./rpc";

export function useThreadSkillSetProvider(
  input: {
    environmentId: EnvironmentId;
    activeThreadId: ThreadId | null;
    gitCwd: string | null;
    routeKind: "server" | "draft";
    activeThread: { readonly skillSetId?: string | null } | undefined;
  },
  provider: ServerProvider | null,
) {
  const { environmentId, gitCwd: cwd } = input;
  const threadId = input.routeKind === "draft" ? null : input.activeThreadId;
  const { settings, statuses } = useSkillSetRegistry(environmentId);
  const instanceId: ProviderInstanceId | undefined = provider?.instanceId;
  const enabled =
    settings.skillSetsEnabled && threadId !== null && cwd !== null && instanceId !== undefined;
  const catalogKey = JSON.stringify([
    environmentId,
    threadId,
    instanceId,
    cwd,
    input.activeThread?.skillSetId,
    settings.defaultSkillSetId,
    settings.skillSets,
    statuses.map(({ id, state, commit, lastChecked }) => [id, state, commit, lastChecked]),
  ]);
  const providers = useAtomValue(threadSkillSetProviders(catalogKey));
  const run = useAtomCommand(refreshThreadSkillSetProviders, { reportFailure: false });
  const refresh = useEffectEvent(() => {
    if (enabled && threadId && cwd && instanceId)
      void run({ environmentId, input: { threadId, cwd, instanceId, catalogKey } });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refresh the server's thread-specific inventory when its pick or source inventory changes
  useEffect(() => {
    if (enabled && catalogKey) refresh();
  }, [enabled, catalogKey]);
  if (!enabled) return provider;
  return (
    providers?.find((candidate) => candidate.instanceId === instanceId) ??
    (provider ? { ...provider, skills: [], slashCommands: [], workspaceSnapshots: [] } : null)
  );
}
