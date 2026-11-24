import type {
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  OrchestrationV2ShellStreamItem,
  ServerConfig,
  ServerConfigStreamEvent,
  SkillSetStatus,
} from "@t3tools/contracts";
import * as Queue from "effect/Queue";

export function refreshFakeSkillSetSubscribers<T extends { readonly olderSettled?: true }>(
  subscribers: {
    readonly configSubscriber: Queue.Queue<ServerConfigStreamEvent> | null;
    readonly skillStatusSubscriber: Queue.Queue<readonly SkillSetStatus[]> | null;
    readonly shellSubscriber: Queue.Queue<OrchestrationV2ShellStreamItem> | null;
  },
  config: ServerConfig,
  statuses: readonly SkillSetStatus[],
  state: {
    readonly sequence: number;
    readonly projects: readonly OrchestrationProjectShell[];
    readonly threads: readonly T[];
  },
  shellOf: (thread: T) => OrchestrationV2ThreadShell,
) {
  if (subscribers.configSubscriber)
    Queue.offerUnsafe(subscribers.configSubscriber, { version: 1, type: "snapshot", config });
  if (subscribers.skillStatusSubscriber)
    Queue.offerUnsafe(subscribers.skillStatusSubscriber, statuses);
  if (subscribers.shellSubscriber)
    Queue.offerUnsafe(subscribers.shellSubscriber, {
      kind: "snapshot",
      snapshot: {
        schemaVersion: 1,
        snapshotSequence: state.sequence,
        projects: state.projects,
        threads: state.threads.filter((thread) => !thread.olderSettled).map(shellOf),
        archivedThreads: [],
      },
    });
}
