// Where a skill set is chosen (prototype). The picked design is "both": tabs across the top of
// the model picker, plus a composer control that always shows the active set. "tabs", "rail"
// and "chip" stay so the earlier screenshots can be re-rendered.
import type { ProjectIconColor } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT } from "gt-react";
import { PlusIcon, Settings2Icon } from "lucide-react";

import { ComposerControl } from "~/components/chat/ComposerControl";
import { useComposerMenuProps } from "~/components/chat/composerEventScope";
import { ProjectMonogram } from "~/components/ProjectMonogram";
import {
  Menu,
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { m, type MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import {
  setActiveSkillSet,
  useSkillSets,
  type SkillSet,
  type SkillSetLogo as Logo,
} from "./skillSetsStore";

export function SkillSetLogo({ logo, className }: { logo: Logo; className?: string }) {
  if (logo.kind === "image") {
    return (
      <img
        src={logo.src}
        alt=""
        className={cn("size-5 shrink-0 rounded-[25%] object-cover", className)}
      />
    );
  }
  return (
    <ProjectMonogram
      text={logo.text}
      color={logo.color as ProjectIconColor}
      className={cn("size-5", className)}
    />
  );
}

/** Sync state in words. Shown in Settings only, the way a provider's status is. */
export const syncLine = (set: SkillSet, resolve: MessageResolver = m) =>
  set.repo.state === "local"
    ? resolve(msg("Local folder, not a repo yet"))
    : resolve(
        msg("Synced {date} · {commit}", {
          date: set.repo.commitDate ?? "",
          commit: set.repo.commit ?? "",
        }),
      );

function useOpenSkillSetSettings() {
  const navigate = useNavigate();
  return () => void navigate({ to: "/settings/skill-sets" as never });
}

/** Tabs above the provider rail, the model list and the effort column. */
export function SkillSetPickerTabs() {
  const gt = useGT();
  const { variant, sets, active } = useSkillSets();
  const openSettings = useOpenSkillSetSettings();
  if (variant !== "tabs" && variant !== "both") return null;
  return (
    <div
      role="tablist"
      aria-label={gt("Skill sets")}
      className="flex shrink-0 items-end gap-0.5 border-b border-border/70 bg-muted/50 px-1.5 pt-1.5"
    >
      {sets.map((set) => {
        const selected = set.id === active.id;
        return (
          <button
            key={set.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => setActiveSkillSet(set.id)}
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
        aria-label={gt("Add skill set")}
        onClick={openSettings}
        className="mb-1 ml-0.5 flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  );
}

/** Earlier option: a second rail on the left of the provider rail, logos only. */
export function SkillSetPickerRail() {
  const gt = useGT();
  const { variant, sets, active } = useSkillSets();
  const openSettings = useOpenSkillSetSettings();
  if (variant !== "rail") return null;
  return (
    <div
      role="toolbar"
      aria-label={gt("Skill sets")}
      aria-orientation="vertical"
      className="flex w-12 shrink-0 flex-col items-stretch gap-1 border-r border-border/70 bg-muted/70 p-1 max-sm:hidden"
    >
      <div className="pt-0.5 pb-1 text-center font-mono text-3xs font-semibold tracking-wider text-muted-foreground uppercase">
        <T>Skills</T>
      </div>
      {sets.map((set) => {
        const selected = set.id === active.id;
        return (
          <Tooltip key={set.id}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={gt("Skill set {name}", { name: set.name })}
                  onClick={() => setActiveSkillSet(set.id)}
                  className={cn(
                    "relative flex aspect-square w-full cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-foreground/10",
                    selected && "bg-background shadow-xs/5",
                  )}
                />
              }
            >
              {selected ? (
                <span className="absolute left-0 h-5 w-0.75 rounded-full bg-primary" />
              ) : null}
              <SkillSetLogo logo={set.logo} className="size-6" />
            </TooltipTrigger>
            <TooltipPopup side="right">
              {gt("{name}: {count, plural, one {{count} skill} other {{count} skills}}", {
                name: set.name,
                count: set.skills.length,
              })}
            </TooltipPopup>
          </Tooltip>
        );
      })}
      <button
        type="button"
        aria-label={gt("Add skill set")}
        onClick={openSettings}
        className="flex aspect-square w-full cursor-pointer items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      >
        <PlusIcon className="size-4" />
      </button>
      <button
        type="button"
        aria-label={gt("Manage skill sets")}
        onClick={openSettings}
        className="mt-auto flex aspect-square w-full cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      >
        <Settings2Icon className="size-4" />
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
  const { variant, sets, active } = useSkillSets();
  const openSettings = useOpenSkillSetSettings();
  const composerMenuProps = useComposerMenuProps();
  if (variant !== "chip" && variant !== "both") return null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <ComposerControl
            aria-label={gt("Skill set: {name}", { name: active.name })}
            className="gap-2"
          />
        }
      >
        <SkillSetLogo logo={active.logo} className="size-4" />
        <span data-composer-control-label>{active.name}</span>
      </MenuTrigger>
      <MenuPopup align="end" side="top" {...composerMenuProps}>
        <MenuGroup>
          <MenuGroupLabel>
            <T>Skill set</T>
          </MenuGroupLabel>
          <MenuRadioGroup value={active.id} onValueChange={setActiveSkillSet}>
            {sets.map((set) => (
              <MenuRadioItem key={set.id} value={set.id} closeOnClick className="min-w-60">
                <span className="flex items-center gap-3 py-1">
                  <SkillSetLogo logo={set.logo} className="size-5" />
                  <span>{set.name}</span>
                  <MenuItemDetail>
                    {gt("{count, plural, one {{count} skill} other {{count} skills}}", {
                      count: set.skills.length,
                    })}
                  </MenuItemDetail>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={openSettings} className="my-1">
          <Settings2Icon />
          <T>Manage skill sets</T>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
