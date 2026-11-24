import { T, useGT, useMessages, Var } from "gt-react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  GitBranchIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { SkillSetConfig, ServerSettingsPatch } from "@t3tools/contracts";
import { useSettingsScope } from "~/components/settings/SettingsScopeContext";
import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { useAtomCommand } from "~/state/use-atom-command";
import { serverEnvironment } from "~/state/server";
import { ProjectIconPickerDialog } from "~/components/settings/ProjectIconPickerDialog";
import { newSkillSet } from "./skillSets.logic";
import { syncSkillSet } from "./rpc";

import { SettingsGroup } from "~/components/settings/SettingsGroup";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { SkillSetLogo, syncLine } from "./SkillSetPickers";
import { useSkillSetRegistry, type SkillSet } from "./skillSetsStore";
import {
  HooksSection,
  InstructionsSection,
  McpSection,
  PluginsSection,
  SkillsSection,
} from "./ProfileSections";
import {
  isStockProfile,
  setProfileIgnoresProject,
  useProfileIgnoresProject,
  useProfileParts,
} from "./profileParts";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-3 px-4 py-2.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function SourceLine({ set }: { set: SkillSet }) {
  const resolve = useMessages();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-3xs text-muted-foreground" />
        }
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            set.repo.state === "local" ? "bg-warning" : "bg-success",
          )}
        />
        {set.repo.state === "local" ? set.repo.path : set.repo.label} · {syncLine(set, resolve)}
      </TooltipTrigger>
      <TooltipPopup>{syncLine(set, resolve)}</TooltipPopup>
    </Tooltip>
  );
}

function ProfilePage({
  set,
  back,
  update,
  patchSettings,
  interval,
  readOnly,
  canSync,
  sync,
}: {
  set: SkillSet;
  back: () => void;
  update: (patch: Partial<SkillSetConfig>) => void;
  patchSettings: (patch: ServerSettingsPatch) => void;
  interval: number;
  readOnly: boolean;
  canSync: boolean;
  sync: () => void;
}) {
  const gt = useGT();
  const parts = useProfileParts(set.id);
  const ignoreProject = useProfileIgnoresProject(set.id);
  const stock = isStockProfile(parts, set.skills.length);
  const local = set.source.kind === "local";
  const [iconOpen, setIconOpen] = useState(false);
  return (
    <>
      <div className="flex flex-col gap-3">
        <Button
          variant="ghost"
          size="xs"
          className="self-start"
          aria-label={gt("Back to agent profiles")}
          onClick={back}
        >
          <ChevronLeftIcon />
          <T>Agent profiles</T>
        </Button>
        <div className="flex items-center gap-3 px-1">
          <SkillSetLogo logo={set.logo} className="size-10" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              {set.name}
              {set.isDefault ? (
                <Badge variant="outline" size="sm">
                  <T>Default</T>
                </Badge>
              ) : null}
            </h2>
            <SourceLine set={set} />
          </div>
          <Switch
            checked={set.enabled}
            disabled={readOnly}
            onCheckedChange={(enabled) => update({ enabled })}
            aria-label={gt("Enable {name}", { name: set.name })}
          />
        </div>
        {stock ? (
          <p className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-sm">
            <T>Stock agent: only the skills built into each CLI.</T>{" "}
            <span className="text-muted-foreground">
              <T>No instructions, plugins, hooks or MCP servers besides T3 Code's own tools.</T>
            </span>
          </p>
        ) : null}
      </div>

      <SettingsSection title={gt("Profile")}>
        <Field label={gt("Logo")}>
          <SkillSetLogo logo={set.logo} className="size-9" />
          <Button variant="outline" size="xs" disabled={readOnly} onClick={() => setIconOpen(true)}>
            <T>Change logo</T>
          </Button>
          <ProjectIconPickerDialog
            current={set.logo.kind === "repo-image" ? set.logo.fallback : set.logo}
            projectName={set.name}
            open={iconOpen}
            onOpenChange={setIconOpen}
            onSelect={(logo) => update({ logo })}
          />
          <Button
            variant="ghost"
            size="xs"
            disabled={readOnly}
            onClick={() => update({ logo: { kind: "repo-image", path: "" } })}
          >
            <T>Use repo image</T>
          </Button>
        </Field>
        <Field label={gt("Name")}>
          <Input
            key={set.name}
            defaultValue={set.name}
            size="compact"
            disabled={readOnly}
            aria-label={gt("Profile name")}
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (name) update({ name });
            }}
          />
        </Field>
        <Field label={gt("Source")}>
          <Input
            readOnly
            value={set.repo.label}
            size="compact"
            font="mono"
            className="min-w-72 flex-1"
          />
          {!local && set.repo.branch ? (
            <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
              <GitBranchIcon className="size-3.5" />
              {set.repo.branch} @ {set.repo.commit}
            </span>
          ) : null}
        </Field>
        <Field label={gt("Auto-sync")}>
          <Switch
            checked={set.autoSync}
            disabled={readOnly}
            onCheckedChange={(autoSync) => update({ autoSync })}
            aria-label={gt("Auto-sync")}
          />
          <Input
            key={interval}
            type="number"
            min={1}
            step={1}
            defaultValue={interval}
            size="compact"
            className="w-20"
            aria-label={gt("Sync interval in minutes")}
            disabled={readOnly}
            onBlur={(event) => {
              const value = Number(event.target.value);
              if (Number.isSafeInteger(value) && value > 0)
                patchSettings({ skillSetSyncIntervalMinutes: value });
            }}
          />
          <span className="text-xs text-muted-foreground">
            <T>minutes</T>
          </span>
          <span className="text-xs text-muted-foreground">
            {local
              ? gt("Local folders are read in place")
              : gt("pulls {branch}; a thread picks up changes on its next message", {
                  branch: set.repo.branch ?? "",
                })}
          </span>
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            disabled={!canSync || set.status?.state === "syncing"}
            onClick={sync}
          >
            <RefreshCwIcon />
            <T>Sync now</T>
          </Button>
        </Field>
        <Field label={gt("Default")}>
          <Switch
            checked={set.isDefault}
            disabled={readOnly}
            aria-label={gt("Default {name}", { name: set.name })}
            onCheckedChange={(checked) =>
              patchSettings({ defaultSkillSetId: checked ? set.id : null })
            }
          />
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            disabled={readOnly}
            onClick={() => {
              patchSettings({
                skillSets: { [set.id]: null },
                ...(set.isDefault ? { defaultSkillSetId: null } : {}),
              });
              back();
            }}
          >
            <T>Remove profile</T>
          </Button>
        </Field>
      </SettingsSection>

      <SettingsSection title={gt("Project files")}>
        <SettingsRow
          title={gt("Ignore project instructions")}
          description={gt(
            "Hides the repo's CLAUDE.md, AGENTS.md and GEMINI.md, its skill folders and its project memory. A thread can change this for itself.",
          )}
          control={
            <Switch
              checked={ignoreProject}
              disabled={readOnly}
              aria-label={gt("Ignore project instructions")}
              onCheckedChange={(checked) => setProfileIgnoresProject(set.id, checked)}
            />
          }
        />
      </SettingsSection>

      <InstructionsSection parts={parts} />
      <SkillsSection set={set} parts={parts} readOnly={readOnly} update={update} />
      <PluginsSection profileId={set.id} parts={parts} readOnly={readOnly} />
      <HooksSection profileId={set.id} parts={parts} readOnly={readOnly} />
      <McpSection parts={parts} />
    </>
  );
}

function ProfileSummary({ set }: { set: SkillSet }) {
  const gt = useGT();
  const parts = useProfileParts(set.id);
  if (isStockProfile(parts, set.skills.length)) return <T>Stock agent</T>;
  const hooks = Object.values(parts.hooks).reduce((sum, list) => sum + list.length, 0);
  return [
    gt("{count, plural, one {{count} skill} other {{count} skills}}", {
      count: set.skills.length,
    }),
    parts.mcp.length > 0
      ? gt("{count, plural, one {{count} MCP server} other {{count} MCP servers}}", {
          count: parts.mcp.length,
        })
      : null,
    hooks > 0
      ? gt("{count, plural, one {{count} hook} other {{count} hooks}}", { count: hooks })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function SkillSetsSettings() {
  const gt = useGT();
  const resolve = useMessages();
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const { sets, settings } = useSkillSetRegistry(environmentId);
  const patchSettings = useUpdateEnvironmentSettings(environmentId);
  const canWrite = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId, {
      patch: { skillSetsEnabled: true },
    }),
  );
  const canSync = useAtomValue(syncSkillSet.permissionAtom(environmentId));
  const sync = useAtomCommand(syncSkillSet, "sync skill set");
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const update = (set: SkillSet, patch: Partial<SkillSetConfig>) => {
    const config = settings.skillSets[set.id];
    if (config) patchSettings({ skillSets: { [set.id]: { ...config, ...patch } } });
  };
  const syncOne = (id: string) => {
    if (environmentId) void sync({ environmentId, input: { id } });
  };
  const register = () => {
    const entry = newSkillSet(name, source, settings.skillSets);
    if (entry.error) {
      setError(resolve(entry.error));
      return;
    }
    if (!entry.config || !entry.id) return;
    patchSettings(
      { skillSets: { [entry.id]: entry.config } },
      {
        onSaved: () => {
          setName("");
          setSource("");
          setError(null);
        },
      },
    );
  };
  const open = sets.find((set) => set.id === openId);
  if (open)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <SettingsPageContainer>
          <ProfilePage
            set={open}
            back={() => setOpenId(null)}
            update={(patch) => update(open, patch)}
            patchSettings={patchSettings}
            interval={settings.skillSetSyncIntervalMinutes}
            readOnly={!canWrite}
            canSync={canSync}
            sync={() => syncOne(open.id)}
          />
        </SettingsPageContainer>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsPageContainer>
        <SettingsSection
          title={gt("Agent profiles")}
          variant="plain"
          headerAction={
            <button
              type="button"
              disabled={!canSync}
              onClick={() => sets.forEach((set) => syncOne(set.id))}
              className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <T>Sync all</T>
            </button>
          }
        >
          <p className="max-w-2xl text-sm text-muted-foreground">
            <T>
              A profile is everything an agent loads: instructions, skills, plugins, hooks and MCP
              servers. Each thread picks one, on any provider account. An empty profile is the stock
              agent.
            </T>
          </p>
          <SettingsGroup className="mt-3">
            <SettingsRow
              title={gt("Enable agent profiles")}
              control={
                <Switch
                  checked={settings.skillSetsEnabled}
                  disabled={!canWrite}
                  aria-label={gt("Enable agent profiles")}
                  onCheckedChange={(skillSetsEnabled) => patchSettings({ skillSetsEnabled })}
                />
              }
            />
            {sets.map((set) => (
              <button
                key={set.id}
                type="button"
                aria-label={gt("{name} details", { name: set.name })}
                onClick={() => setOpenId(set.id)}
                className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-foreground/3"
              >
                <SkillSetLogo logo={set.logo} className="size-9" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {set.name}
                    {set.isDefault ? (
                      <Badge variant="outline" size="sm">
                        <T>Default</T>
                      </Badge>
                    ) : null}
                    {set.enabled ? null : (
                      <Badge variant="outline" size="sm">
                        <T>Off</T>
                      </Badge>
                    )}
                  </span>
                  <span className="truncate font-mono text-3xs text-muted-foreground">
                    {set.repo.state === "local" ? set.repo.path : set.repo.label}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  <ProfileSummary set={set} />
                </span>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[25%] border border-dashed border-border text-muted-foreground">
                <PlusIcon className="size-4" />
              </span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={!canWrite}
                aria-label={gt("New profile name")}
                placeholder={gt("Name")}
                size="compact"
                className="w-36"
              />
              <Input
                value={source}
                onChange={(event) => setSource(event.target.value)}
                disabled={!canWrite}
                aria-label={gt("Git URL or local folder")}
                placeholder={gt("github.com/owner/repo, or a local profile folder")}
                size="compact"
                font="mono"
                className="flex-1"
              />
              <Button variant="outline" size="xs" disabled={!canWrite} onClick={register}>
                <T>Add profile</T>
              </Button>
            </div>
          </SettingsGroup>
          {error ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            <T>
              Try one: <Var>{<span className="font-mono">garrytan/gstack</span>}</Var> ·{" "}
              <Var>{<span className="font-mono">backnotprop/pstack</span>}</Var> ·{" "}
              <Var>{<span className="font-mono">t3dotgg/tstack</span>}</Var>
            </T>
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    </div>
  );
}
