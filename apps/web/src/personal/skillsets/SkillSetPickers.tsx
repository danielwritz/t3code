import { SkillSetRepoImage } from "./SkillSetRepoImage";
import { formatRelativeTime, parseTimestampDate } from "~/timestampFormat";
import { createElement } from "react";
import { lucideIconByName } from "~/lib/lucideIconByName";
import { projectIconColorClassName } from "~/projectIconColors";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT } from "gt-react";
import { FileMinusIcon, PlusIcon, Settings2Icon } from "lucide-react";

import { ComposerControl } from "~/components/chat/ComposerControl";
import { useComposerMenuProps } from "~/components/chat/composerEventScope";
import { ProjectMonogram } from "~/components/ProjectMonogram";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { m, type MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import {
  useSkillSets,
  AttachedSkillSetChipScope,
  type SkillSet,
  type SkillSetLogo as Logo,
} from "./skillSetsStore";
import {
  isStockProfile,
  setThreadIgnoresProject,
  useProfileParts,
  useThreadIgnoresProject,
} from "./profileParts";

export function SkillSetLogo({ logo, className }: { logo: Logo; className?: string | undefined }) {
  if (logo.kind === "repo-image") return <SkillSetRepoImage logo={logo} className={className} />;
  if (logo.kind === "emoji")
    return (
      <span aria-hidden className={cn("size-5 shrink-0", className)}>
        {logo.emoji}
      </span>
    );
  if (logo.kind === "lucide") {
    const icon = lucideIconByName(logo.name);
    return icon
      ? createElement(icon, {
          className: cn("size-5 shrink-0", projectIconColorClassName(logo.color), className),
        })
      : null;
  }
  return (
    <ProjectMonogram text={logo.text} color={logo.color} className={cn("size-5", className)} />
  );
}

/** Sync state in words. Shown in Settings only, the way a provider's status is. */
export const syncLine = (set: SkillSet, resolve: MessageResolver = m) => {
  const status = set.status;
  const state =
    !status || status.state === "syncing"
      ? resolve(msg("Syncing"))
      : status.state === "local"
        ? resolve(msg("Local folder"))
        : status.state === "error"
          ? resolve(msg("Sync failed"))
          : resolve(msg("Synced"));
  return [
    state,
    set.repo.commit,
    status?.commitDate
      ? parseTimestampDate(status.commitDate)?.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : null,
    status?.lastChecked
      ? resolve(
          msg("Checked {date}", {
            date: formatRelativeTime(status.lastChecked, undefined, resolve)?.label ?? "",
          }),
        )
      : null,
    status?.error,
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
};

function ProfileMenuDetail({ set }: { set: SkillSet }) {
  const gt = useGT();
  const parts = useProfileParts(set.id);
  return (
    <MenuItemDetail>
      {isStockProfile(parts, set.skills.length)
        ? gt("Stock agent")
        : gt("{count, plural, one {{count} skill} other {{count} skills}}", {
            count: set.skills.length,
          })}
    </MenuItemDetail>
  );
}

function useOpenSkillSetSettings() {
  const navigate = useNavigate();
  return () => void navigate({ to: "/settings/skill-sets" as never });
}

/** Tabs above the provider rail, the model list and the effort column. */
export function SkillSetPickerTabs() {
  const gt = useGT();
  const { settings, sets, active, setActive, permitted, available } = useSkillSets();
  const openSettings = useOpenSkillSetSettings();
  if (!available || !settings.skillSetsEnabled || sets.length === 0) return null;
  return (
    <div
      role="tablist"
      aria-label={gt("Agent profiles")}
      className="flex shrink-0 items-end gap-0.5 border-b border-border/70 bg-muted/50 px-1.5 pt-1.5"
    >
      {sets.map((set) => {
        const selected = set.id === active?.id;
        return (
          <button
            key={set.id}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={!permitted}
            onClick={() => setActive(set.id)}
            className={cn(
              "-mb-px flex cursor-pointer items-center gap-1.5 rounded-t-lg border border-b-0 px-3 py-1.5 text-sm transition-colors",
              selected
                ? "border-border/70 bg-popover font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            <SkillSetLogo logo={set.logo} className="size-4" />
            <span>{set.name}</span>
          </button>
        );
      })}
      <button
        type="button"
        aria-label={gt("Add agent profile")}
        onClick={openSettings}
        className="mb-1 ml-0.5 flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * The composer control: the active set is always in view, and its menu is built from the same
 * menu parts as the composer's other menus, so it takes their spacing, type and colors.
 */
export function SkillSetComposerChip() {
  const gt = useGT();
  const { settings, sets, active, setActive, permitted, available, threadKey } = useSkillSets();
  const openSettings = useOpenSkillSetSettings();
  const composerMenuProps = useComposerMenuProps();
  const { ignore, overridden } = useThreadIgnoresProject(active?.id, threadKey);
  if (!available || !settings.skillSetsEnabled || sets.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <ComposerControl
            disabled={!permitted}
            aria-label={gt("Agent profile: {name}", { name: active?.name ?? gt("Agent profile") })}
            className="gap-2"
          />
        }
      >
        {active ? <SkillSetLogo logo={active.logo} className="size-4" /> : null}
        <span data-composer-control-label>{active?.name ?? gt("Agent profile")}</span>
        {ignore ? (
          <FileMinusIcon
            aria-label={gt("Ignoring project instructions")}
            className="size-3.5 text-muted-foreground"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="top" {...composerMenuProps}>
        <MenuGroup>
          <MenuGroupLabel>
            <T>Agent profile</T>
          </MenuGroupLabel>
          <MenuRadioGroup value={active?.id ?? ""} onValueChange={setActive}>
            {sets.map((set) => (
              <MenuRadioItem key={set.id} value={set.id} closeOnClick className="min-w-60">
                <span className="flex items-center gap-3 py-1">
                  <SkillSetLogo logo={set.logo} className="size-5" />
                  <span>{set.name}</span>
                  <ProfileMenuDetail set={set} />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuCheckboxItem
          variant="switch"
          checked={ignore}
          disabled={!permitted || !threadKey || !active}
          onCheckedChange={(checked) => {
            if (threadKey) setThreadIgnoresProject(threadKey, checked);
          }}
          className="my-1"
        >
          <span className="flex flex-col py-0.5">
            <T>Ignore project instructions</T>
            <span className="text-xs text-muted-foreground">
              {overridden ? <T>This thread only</T> : <T>Same as the profile</T>}
            </span>
          </span>
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuItem onClick={openSettings} className="my-1">
          <Settings2Icon />
          <T>Manage agent profiles</T>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function AttachedSkillSetChip({
  environmentId,
  threadId,
}: {
  environmentId: import("@t3tools/contracts").EnvironmentId;
  threadId: import("@t3tools/contracts").ThreadId;
}) {
  return (
    <AttachedSkillSetChipScope environmentId={environmentId} threadId={threadId}>
      <SkillSetComposerChip />
    </AttachedSkillSetChipScope>
  );
}
