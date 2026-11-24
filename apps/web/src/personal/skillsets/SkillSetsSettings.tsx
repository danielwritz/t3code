import { T, useGT, useMessages, Var } from "gt-react";
import { ChevronRightIcon, GitBranchIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { SkillSetConfig, ServerSettingsPatch } from "@t3tools/contracts";
import { useSettingsScope } from "~/components/settings/SettingsScopeContext";
import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { useAtomCommand } from "~/state/use-atom-command";
import { serverEnvironment } from "~/state/server";
import { ProjectIconPickerDialog } from "~/components/settings/ProjectIconPickerDialog";
import { newSkillSet } from "./skillSets.logic";
import { syncSkillSet } from "./rpc";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { SettingsGroup } from "~/components/settings/SettingsGroup";
import { SettingsPageContainer, SettingsSection } from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { SkillSetLogo, syncLine } from "./SkillSetPickers";
import { useSkillSetRegistry, type SkillSet, type SkillSetSkill } from "./skillSetsStore";

const PROVIDERS = [
  { driver: "codex", name: "Codex" },
  { driver: "claudeAgent", name: "Claude" },
  { driver: "antigravity", name: "Antigravity" },
] as const;
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-3 px-4 py-2.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function SkillRow({
  skill,
  onChange,
  readOnly,
}: {
  skill: SkillSetSkill;
  onChange: (enabled: boolean) => void;
  readOnly: boolean;
}) {
  const gt = useGT();
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <Switch
        checked={skill.enabled}
        onCheckedChange={onChange}
        disabled={readOnly}
        aria-label={gt("Load {name}", { name: skill.name })}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 font-mono text-xs font-medium">
          {skill.name}
          {skill.manualOnly ? (
            <span className="rounded-sm border border-border px-1 font-sans text-3xs font-normal text-muted-foreground">
              <T>/command only</T>
            </span>
          ) : null}
        </span>
        <span className="truncate text-xs text-muted-foreground">{skill.description}</span>
      </div>
    </div>
  );
}

function SkillSetDetail({
  set,
  update,
  patchSettings,
  interval,
  readOnly,
  canSync,
  sync,
}: {
  set: SkillSet;
  update: (patch: Partial<SkillSetConfig>) => void;
  patchSettings: (patch: ServerSettingsPatch) => void;
  interval: number;
  readOnly: boolean;
  canSync: boolean;
  sync: () => void;
}) {
  const gt = useGT();
  const local = set.source.kind === "local";
  const [iconOpen, setIconOpen] = useState(false);
  return (
    <div className="border-t border-border/50 bg-muted/20">
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
          aria-label={gt("Skill set name")}
          onBlur={(event) => {
            const name = event.target.value.trim();
            if (name) update({ name });
          }}
        />
      </Field>
      <Field label={gt("Repo")}>
        <Input readOnly value={set.repo.label} size="compact" font="mono" className="w-72" />
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
      <Field label={gt("Loads for")}>
        {PROVIDERS.map((provider) => (
          <span
            key={provider.name}
            className="flex items-center gap-1.5 rounded-full border border-border bg-popover py-0.5 pr-2.5 pl-1.5 text-xs"
          >
            <ProviderInstanceIcon
              driverKind={provider.driver as never}
              displayName={provider.name}
              className="size-4"
              iconClassName="size-3.5"
            />
            {provider.name}
          </span>
        ))}
        <span className="text-xs text-muted-foreground">
          <T>one set, every provider account</T>
        </span>
      </Field>
      <div className="border-t border-border/50">
        <div className="flex items-center justify-between px-4 pt-2.5 pb-1">
          <span className="text-sm font-medium">
            <T>
              Skills{" "}
              <span className="text-muted-foreground">
                (<Var>{set.skills.length}</Var> load)
              </span>
            </T>
          </span>
        </div>
        <div className="max-h-80 overflow-y-auto pb-2">
          {set.skills.map((skill) => (
            <SkillRow
              key={skill.name}
              skill={skill}
              readOnly={readOnly}
              onChange={(enabled) =>
                update({
                  disabledSkills: enabled
                    ? set.disabledSkills.filter((name) => name !== skill.name)
                    : [...new Set([...set.disabledSkills, skill.name])],
                })
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
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
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsPageContainer>
        <SettingsSection
          title={gt("Skill sets")}
          variant="plain"
          headerAction={
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <button
                type="button"
                disabled={!canSync}
                onClick={() => sets.forEach((set) => syncOne(set.id))}
                className="cursor-pointer font-medium hover:text-foreground"
              >
                <T>Sync all</T>
              </button>
            </div>
          }
        >
          <p className="max-w-2xl text-sm text-muted-foreground">
            <T>
              A skill set is a git repo of agent skills. T3 Code keeps each registered repo in sync
              and loads only the set a thread picks, on any provider account.
            </T>
          </p>
          <SettingsGroup className="mt-3">
            <Field label={gt("Enable skill sets")}>
              <Switch
                checked={settings.skillSetsEnabled}
                disabled={!canWrite}
                aria-label={gt("Enable skill sets")}
                onCheckedChange={(skillSetsEnabled) => patchSettings({ skillSetsEnabled })}
              />
            </Field>
            {sets.map((set) => {
              const open = openId === set.id;
              return (
                <div key={set.id}>
                  <div className="flex items-center gap-3 px-4 py-3">
                    <SkillSetLogo logo={set.logo} className="size-9" />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {set.name}
                        {set.isDefault ? (
                          <Badge variant="outline" size="sm">
                            <T>Default</T>
                          </Badge>
                        ) : null}
                      </span>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-3xs text-muted-foreground" />
                          }
                        >
                          <span
                            className={cn(
                              "size-1.5 rounded-full",
                              set.repo.state === "local" ? "bg-warning" : "bg-success",
                            )}
                          />
                          {set.repo.state === "local" ? set.repo.path : set.repo.label} ·{" "}
                          {syncLine(set, resolve)}
                        </TooltipTrigger>
                        <TooltipPopup>{syncLine(set, resolve)}</TooltipPopup>
                      </Tooltip>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs">
                      <span className="font-medium tabular-nums">
                        {gt("{count, plural, one {{count} skill} other {{count} skills}}", {
                          count: set.skills.length,
                        })}
                      </span>
                    </div>
                    <Switch
                      checked={set.enabled}
                      disabled={!canWrite}
                      onCheckedChange={(enabled) => update(set, { enabled })}
                      aria-label={gt("Enable {name}", { name: set.name })}
                    />
                    <button
                      type="button"
                      aria-label={gt("{name} details", { name: set.name })}
                      aria-expanded={open}
                      onClick={() => setOpenId(open ? null : set.id)}
                      className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                    >
                      <ChevronRightIcon
                        className={cn("size-4 transition-transform", open && "rotate-90")}
                      />
                    </button>
                  </div>
                  {open ? (
                    <>
                      <SkillSetDetail
                        set={set}
                        update={(patch) => update(set, patch)}
                        patchSettings={patchSettings}
                        interval={settings.skillSetSyncIntervalMinutes}
                        readOnly={!canWrite}
                        canSync={canSync}
                        sync={() => syncOne(set.id)}
                      />
                      <Field label={gt("Default")}>
                        <Switch
                          checked={set.isDefault}
                          disabled={!canWrite}
                          aria-label={gt("Default {name}", { name: set.name })}
                          onCheckedChange={(checked) =>
                            patchSettings({ defaultSkillSetId: checked ? set.id : null })
                          }
                        />
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={!canWrite}
                          onClick={() =>
                            patchSettings({
                              skillSets: { [set.id]: null },
                              ...(set.isDefault ? { defaultSkillSetId: null } : {}),
                            })
                          }
                        >
                          <T>Remove skill set</T>
                        </Button>
                      </Field>
                    </>
                  ) : null}
                </div>
              );
            })}
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[25%] border border-dashed border-border text-muted-foreground">
                <PlusIcon className="size-4" />
              </span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={!canWrite}
                aria-label={gt("New skill set name")}
                placeholder={gt("Name")}
                size="compact"
                className="w-36"
              />
              <Input
                value={source}
                onChange={(event) => setSource(event.target.value)}
                disabled={!canWrite}
                aria-label={gt("Git URL or local folder")}
                placeholder={gt("github.com/owner/repo, or a local folder of skills")}
                size="compact"
                font="mono"
                className="flex-1"
              />
              <Button variant="outline" size="xs" disabled={!canWrite} onClick={register}>
                <T>Register skill set</T>
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
