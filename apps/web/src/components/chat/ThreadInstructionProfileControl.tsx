import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ScrollTextIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { instructionProfileEnvironment } from "../../state/instructionProfiles";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadProfileChoice } from "../settings/InstructionProfilesSettings.logic";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Badge } from "../ui/badge";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const INHERIT = "";

/** The thread's instruction profile: which one applies, where it comes from, and a way to change it. */
export function ThreadInstructionProfileControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}) {
  const { environmentId, threadId, projectId } = props;
  const navigate = useNavigate();
  const threadQuery = useEnvironmentQuery(
    instructionProfileEnvironment.threadProfile({ environmentId, input: { threadId } }),
  );
  const profilesQuery = useEnvironmentQuery(
    instructionProfileEnvironment.profiles({ environmentId, input: {} }),
  );
  const canSetThread = useAtomValue(
    instructionProfileEnvironment.setThread.permissionAtom(environmentId),
  );
  const canSetProject = useAtomValue(
    instructionProfileEnvironment.setProject.permissionAtom(environmentId),
  );
  const setThread = useAtomCommand(instructionProfileEnvironment.setThread, {
    label: "set thread instruction profile",
  });
  const setProject = useAtomCommand(instructionProfileEnvironment.setProject, {
    label: "set project instruction profile",
  });

  const current = threadQuery.data;
  const profiles = profilesQuery.data?.profiles ?? [];
  const choice = current === null ? null : threadProfileChoice(current);
  const inheritedId =
    current === null ? null : (current.projectProfileId ?? current.defaultProfileId);
  const inheritedName = profiles.find((profile) => profile.id === inheritedId)?.name ?? "none";
  const inheritedSource =
    current?.projectProfileId !== null && current?.projectProfileId !== undefined
      ? "the project"
      : "the default";

  return (
    <Menu
      onOpenChange={(open) => {
        // Another tab or device may have changed the profiles since this row loaded.
        if (!open) return;
        profilesQuery.refresh();
        threadQuery.refresh();
      }}
    >
      <MenuTrigger
        render={<ThreadDetailsControl part="select" multiline />}
        aria-label={choice?.label ?? "Instruction profile: loading"}
      >
        <ScrollTextIcon className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, "me-1")} aria-hidden />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate">{choice?.name ?? "Instruction profile"}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-normal text-muted-foreground">
            <span className="truncate">{choice?.source ?? "Loading…"}</span>
            {choice?.interfaceOnly ? (
              <Badge size="sm" variant="outline">
                Interface only
              </Badge>
            ) : null}
          </span>
        </span>
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="w-(--anchor-width) min-w-64">
        <MenuGroup>
          <MenuGroupLabel>Instruction profile for this thread</MenuGroupLabel>
          <MenuRadioGroup
            value={current?.threadProfileId ?? INHERIT}
            onValueChange={(value) =>
              void setThread({
                environmentId,
                input: { threadId, profileId: value === INHERIT ? null : String(value) },
              })
            }
          >
            <MenuRadioItem value={INHERIT} disabled={!canSetThread} closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                <MenuRadioItemIndicator />
                <span className="min-w-0 break-words">
                  Same as {inheritedSource}: {inheritedName}
                </span>
              </span>
            </MenuRadioItem>
            {profiles.map((profile) => (
              <MenuRadioItem
                key={profile.id}
                value={profile.id}
                disabled={!canSetThread}
                closeOnClick
              >
                <span className="flex min-w-0 items-center gap-2">
                  <MenuRadioItemIndicator />
                  <span className="min-w-0 break-words">{profile.name}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        {current?.profile === undefined ? null : (
          <MenuItem
            disabled={!canSetProject || current.projectProfileId === current.profile.id}
            onClick={() => {
              const profileId = current.profile?.id;
              if (profileId === undefined) return;
              void setProject({ environmentId, input: { projectId, profileId } });
            }}
          >
            <span className="min-w-0 break-words">Use {current.profile.name} for this project</span>
          </MenuItem>
        )}
        <MenuItem onClick={() => void navigate({ to: "/settings/instruction-profiles" })}>
          Manage instruction profiles
        </MenuItem>
        <MenuSeparator />
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          Applies from the next time this thread's agent starts or resumes.
        </p>
      </MenuPopup>
    </Menu>
  );
}
