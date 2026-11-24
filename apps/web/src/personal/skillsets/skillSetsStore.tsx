import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type SkillSetStatus,
  type ServerSettings,
  DEFAULT_SERVER_SETTINGS,
  CommandId,
  skillSetParentThreadId,
  type ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { randomUUID } from "~/lib/utils";
import { createContext, useContext, memo, type ComponentType, type ReactNode } from "react";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useAtomCommand } from "~/state/use-atom-command";
import { environmentThreadShells } from "~/state/threads";
import { serverEnvironment } from "~/state/server";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { activeSkillSet, joinSkillSets } from "./skillSets.logic";
import { pickSkillSet, skillSetStatuses } from "./rpc";

export type { SkillSet, SkillSetSkill } from "./skillSets.logic";
export type SkillSetLogo = import("./skillSets.logic").SkillSet["logo"];

const emptySettings = Atom.make<ServerSettings | null>(null);
const emptyStatuses = Atom.make(AsyncResult.success<readonly SkillSetStatus[]>([]));
const noPermission = Atom.make(false);
const SkillSetContext = createContext<{
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  draftId: DraftId | null;
} | null>(null);

function SkillSetScope({
  environmentId,
  threadId,
  draftId,
  children,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  draftId: DraftId | null;
  children: ReactNode;
}) {
  return <SkillSetContext value={{ environmentId, threadId, draftId }}>{children}</SkillSetContext>;
}

export function withSkillSetScope<
  Props extends {
    environmentId: EnvironmentId;
    activeThreadId: ThreadId | null;
    draftId: DraftId | null;
  },
>(Component: ComponentType<Props>) {
  return memo(function SkillSetComposer(props: Props) {
    return (
      <SkillSetScope
        environmentId={props.environmentId}
        threadId={props.activeThreadId}
        draftId={props.draftId}
      >
        <Component {...props} />
      </SkillSetScope>
    );
  });
}

export function useSkillSetRegistry(environmentId: EnvironmentId | null) {
  const settings =
    useAtomValue(
      environmentId ? serverEnvironment.settingsValueAtom(environmentId) : emptySettings,
    ) ?? DEFAULT_SERVER_SETTINGS;
  const result = useAtomValue(
    environmentId && (settings.skillSetsEnabled || Object.keys(settings.skillSets).length > 0)
      ? skillSetStatuses({ environmentId, input: {} })
      : emptyStatuses,
  );
  const statuses = AsyncResult.getOrElse(result, () => []);
  return {
    settings,
    statuses,
    sets: joinSkillSets(settings.skillSets, statuses, settings.defaultSkillSetId, environmentId),
  };
}

const ownerThreadAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const { environmentId, threadId } = JSON.parse(key) as {
      environmentId: EnvironmentId;
      threadId: ThreadId;
    };
    let thread = get(environmentThreadShells.threadShellAtom({ environmentId, threadId }));
    const visited = new Set<ThreadId>([threadId]);
    let parentId = thread ? skillSetParentThreadId(thread) : null;
    const attached = parentId !== null;
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId);
      thread = get(environmentThreadShells.threadShellAtom({ environmentId, threadId: parentId }));
      parentId = thread ? skillSetParentThreadId(thread) : null;
    }
    return { thread, attached };
  }),
);
const emptyOwner = Atom.make({ thread: null, attached: false });

export function useSkillSets() {
  const scope = useContext(SkillSetContext);
  const primary = usePrimaryEnvironmentId();
  const environmentId = scope?.environmentId ?? primary;
  const registry = useSkillSetRegistry(environmentId);
  const owner = useAtomValue(
    scope?.threadId
      ? ownerThreadAtom(
          JSON.stringify({ environmentId: scope.environmentId, threadId: scope.threadId }),
        )
      : emptyOwner,
  );
  const thread = owner.thread;
  const draft = useComposerDraftStore((state) =>
    scope?.draftId ? state.draftThreadsByThreadKey[scope.draftId] : undefined,
  );
  const pick = draft?.skillSetId ?? thread?.skillSetId;
  const active = activeSkillSet(
    registry.settings.skillSetsEnabled,
    registry.sets,
    pick,
    registry.settings.defaultSkillSetId,
  );
  const permitted = useAtomValue(
    environmentId ? pickSkillSet.permissionAtom(environmentId) : noPermission,
  );
  const save = useAtomCommand(pickSkillSet, "change skill set");
  const setActive = (skillSetId: string) => {
    if (!scope || !permitted || owner.attached) return;
    const draftId = scope.draftId;
    if (draftId && draft) {
      useComposerDraftStore.setState((state) => ({
        draftThreadsByThreadKey: {
          ...state.draftThreadsByThreadKey,
          [draftId]: { ...state.draftThreadsByThreadKey[draftId]!, skillSetId },
        },
      }));
    } else if (scope.threadId) {
      void save({
        environmentId: scope.environmentId,
        input: {
          type: "thread.metadata.update",
          commandId: CommandId.make(randomUUID()),
          threadId: scope.threadId,
          skillSetId,
        },
      });
    }
  };
  return {
    ...registry,
    active,
    sets: registry.sets.filter((set) => set.enabled),
    setActive,
    permitted: permitted && !owner.attached,
    available: scope !== null,
    threadKey: scope?.threadId ?? scope?.draftId ?? null,
  };
}

export function AttachedSkillSetChipScope({
  environmentId,
  threadId,
  children,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  children: ReactNode;
}) {
  return (
    <SkillSetScope environmentId={environmentId} threadId={threadId} draftId={null}>
      {children}
    </SkillSetScope>
  );
}
