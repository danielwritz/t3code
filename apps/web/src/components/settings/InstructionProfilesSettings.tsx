import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  INSTRUCTION_PROFILE_ALL_ITEMS,
  type EnvironmentId,
  type InstructionProfile,
  type InstructionProfileEffectKind,
  type InstructionProfileItemKind,
  type InstructionProfileSupportLevel,
  type ProjectId,
} from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useProjects } from "../../state/entities";
import { instructionProfileEnvironment } from "../../state/instructionProfiles";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  draftFromProfile,
  emptyProfileDraft,
  INSTRUCTION_PROFILE_ITEM_KINDS,
  instructionProfileItemLabel,
  instructionProfileKindLabel,
  instructionProfileSummary,
  instructionProfileSupportResult,
  instructionProfileSupportRows,
  isProfileDraftChanged,
  newProfileDraftItemKey,
  profileDraftSaveInput,
  type ProfileDraft,
} from "./InstructionProfilesSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";

const NONE = "";

const SUPPORT_DOT: Readonly<Record<InstructionProfileSupportLevel, string>> = {
  yes: "bg-emerald-500",
  partial: "bg-amber-500",
  no: "bg-muted-foreground/40",
};

const SUPPORT_COLUMNS: ReadonlyArray<{ kind: InstructionProfileEffectKind; label: string }> = [
  { kind: "global-instructions", label: "Your instructions" },
  { kind: "skill", label: "Skills" },
  { kind: "agent", label: "Agents" },
  { kind: "mcpServer", label: "MCP servers" },
  { kind: "host", label: "T3 Code features" },
];

export function InstructionProfilesSettings() {
  const { environment } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <SettingsSection {...searchableSetting("instruction-profiles")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect an environment to manage its instruction profiles.
          </p>
        </SettingsSection>
      ) : (
        <InstructionProfilesForEnvironment key={environmentId} environmentId={environmentId} />
      )}
    </SettingsPageContainer>
  );
}

function InstructionProfilesForEnvironment({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const query = useEnvironmentQuery(
    instructionProfileEnvironment.profiles({ environmentId, input: {} }),
  );
  const canEdit = useAtomValue(instructionProfileEnvironment.save.permissionAtom(environmentId));
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const profiles = query.data?.profiles ?? [];
  const editing = draft?.id === undefined ? undefined : profiles.find((p) => p.id === draft.id);

  return (
    <>
      <SettingsSection
        {...searchableSetting("instruction-profiles")}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={!canEdit || draft !== null}
            onClick={() => setDraft(emptyProfileDraft())}
          >
            <PlusIcon aria-hidden />
            New profile
          </Button>
        }
      >
        <p className="px-4 pt-3 pb-1 text-sm text-muted-foreground">
          A profile decides what your agents get: your own instructions, whether T3 Code adds its
          features, and which of your skills, agents and MCP servers are off. It applies when the
          agent session starts or resumes. Your own files are never changed.
        </p>
        {query.data === null && query.isPending ? (
          <div className="grid gap-2 px-4 py-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : query.data === null && query.error !== null ? (
          <SettingsRow
            title="Could not load instruction profiles"
            description={query.error}
            control={
              <Button size="xs" variant="outline" onClick={query.refresh}>
                Retry
              </Button>
            }
          />
        ) : profiles.length === 0 ? (
          <p className="px-4 pb-3 text-sm text-muted-foreground">No profiles yet.</p>
        ) : (
          profiles.map((profile) => (
            <SettingsRow
              key={profile.id}
              title={profile.name}
              description={profileSummary(profile)}
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canEdit || draft !== null}
                  aria-label={`Edit ${profile.name}`}
                  onClick={() => setDraft(draftFromProfile(profile))}
                >
                  Edit
                </Button>
              }
            />
          ))
        )}
      </SettingsSection>

      {draft === null ? null : (
        <ProfileEditor
          // A different profile starts from its own saved fields.
          key={draft.id ?? "new"}
          environmentId={environmentId}
          initial={draft}
          saved={editing}
          profiles={profiles}
          onDone={() => setDraft(null)}
        />
      )}

      <ProfileDefaults environmentId={environmentId} profiles={profiles} canEdit={canEdit} />
      <ProfileSupport environmentId={environmentId} />
    </>
  );
}

function profileSummary(profile: InstructionProfile): string {
  return [profile.description.trim(), instructionProfileSummary(profile)]
    .filter((part) => part.length > 0)
    .join(" · ");
}

const draftSummaryInput = (draft: ProfileDraft) => ({
  globalInstructions: draft.globalInstructions,
  items: [
    ...draft.items.filter((item) => item.name.trim().length > 0),
    ...(draft.t3
      ? []
      : [{ kind: "host" as const, name: INSTRUCTION_PROFILE_ALL_ITEMS, enabled: false }]),
  ],
});

function ProfileEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly initial: ProfileDraft;
  readonly saved: InstructionProfile | undefined;
  readonly profiles: ReadonlyArray<InstructionProfile>;
  readonly onDone: () => void;
}) {
  const save = useAtomCommand(instructionProfileEnvironment.save, {
    label: "save instruction profile",
  });
  const remove = useAtomCommand(instructionProfileEnvironment.remove, {
    label: "delete instruction profile",
  });
  const [draft, setDraft] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isNew = draft.id === undefined;
  const changed = isProfileDraftChanged(draft, props.saved);

  const setItem = (key: string, patch: Partial<ProfileDraft["items"][number]>) =>
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    }));

  const submit = async () => {
    const result = profileDraftSaveInput(draft, props.profiles);
    if (!result.ok) {
      setFailure(result.error);
      return;
    }
    setBusy(true);
    setFailure(null);
    const outcome = await save({ environmentId: props.environmentId, input: result.input });
    setBusy(false);
    if (outcome._tag === "Success") {
      props.onDone();
      return;
    }
    const error = squashAtomCommandFailure(outcome);
    setFailure(error instanceof Error ? error.message : "The profile could not be saved.");
  };

  const deleteProfile = async () => {
    if (draft.id === undefined) return;
    setBusy(true);
    const outcome = await remove({ environmentId: props.environmentId, input: { id: draft.id } });
    setBusy(false);
    setConfirmDelete(false);
    if (outcome._tag === "Success") {
      props.onDone();
      return;
    }
    const error = squashAtomCommandFailure(outcome);
    setFailure(error instanceof Error ? error.message : "The profile could not be deleted.");
  };

  return (
    <SettingsSection title={isNew ? "New profile" : `Edit profile: ${props.saved?.name ?? ""}`}>
      <fieldset disabled={busy} className="contents">
        <div className="grid gap-5 px-4 py-4">
          <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm" aria-live="polite">
            <span className="text-muted-foreground">Agents under this profile get: </span>
            {instructionProfileSummary(draftSummaryInput(draft))}
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Name</span>
              <Input
                size="sm"
                autoFocus
                value={draft.name}
                placeholder="Short replies"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Description</span>
              <Input
                size="sm"
                value={draft.description}
                placeholder="What this profile is for"
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
          </div>

          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">1. What should every agent be told?</span>
            <span className="text-xs text-muted-foreground">
              Sent to Claude, Codex, Antigravity and other agents, after T3 Code's own instructions.
              Leave it empty to add nothing.
            </span>
            <Textarea
              rows={6}
              value={draft.globalInstructions}
              placeholder="Keep replies short. Put the answer first."
              onChange={(event) => setDraft({ ...draft, globalInstructions: event.target.value })}
            />
            <span className="text-xs text-muted-foreground tabular-nums">
              {draft.globalInstructions.trim().length.toLocaleString()} characters
            </span>
          </label>

          <div className="grid gap-1.5 text-sm">
            <span className="font-medium" id="t3-choice-label">
              2. What may T3 Code add?
            </span>
            <RadioGroup
              aria-labelledby="t3-choice-label"
              value={draft.t3 ? "features" : "interface"}
              onValueChange={(value) => setDraft({ ...draft, t3: value === "features" })}
            >
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-data-checked:border-ring">
                <Radio value="features" aria-label="T3 Code features" />
                <span className="grid gap-1">
                  <span className="font-medium">T3 Code features (default)</span>
                  <span className="text-xs text-muted-foreground">
                    The agent can start and wait on other threads, message you mid-turn, link pull
                    requests, and use previews and devices. This costs about 6,000 characters of
                    instructions and up to 79 tool definitions for each agent.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-data-checked:border-ring">
                <Radio value="interface" aria-label="Interface only" />
                <span className="grid gap-1">
                  <span className="font-medium">Interface only</span>
                  <span className="text-xs text-muted-foreground">
                    T3 Code adds nothing. The agent runs as it does in its own app. Chat, Stop and
                    permission prompts keep working.
                  </span>
                  <span className="text-xs text-muted-foreground">
                    You lose: other threads and delegation, messages mid-turn, pull request links,
                    previews and devices, and scheduled tasks.
                  </span>
                </span>
              </label>
            </RadioGroup>
          </div>

          <div className="grid gap-2 text-sm">
            <span className="font-medium">
              3. Which of your own skills, agents and MCP servers are off?
            </span>
            <span className="text-xs text-muted-foreground">
              Use * as the name to turn off every item of that kind.
            </span>
            {draft.items.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                None. The agent keeps all its skills, agents and MCP servers.
              </p>
            ) : (
              <ul className="m-0 grid list-none gap-2 p-0">
                {draft.items.map((item, index) => (
                  <li
                    key={item.key}
                    className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 sm:flex"
                  >
                    <Select
                      value={item.kind}
                      onValueChange={(next) => {
                        if (next !== null) setItem(item.key, { kind: next });
                      }}
                    >
                      <SelectTrigger
                        aria-label={`Kind of switch ${index + 1}`}
                        className="w-full sm:w-36"
                        size="sm"
                      >
                        <SelectValue>{instructionProfileKindLabel(item.kind)}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {INSTRUCTION_PROFILE_ITEM_KINDS.map((kind) => (
                          <SelectItem key={kind} value={kind}>
                            {instructionProfileKindLabel(kind)}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    <Input
                      size="sm"
                      className="min-w-0 flex-1 max-sm:col-span-3 max-sm:row-start-2"
                      aria-label={`Name of switch ${index + 1}`}
                      value={item.name}
                      placeholder="Name, or * for all"
                      onChange={(event) => setItem(item.key, { name: event.target.value })}
                    />
                    <label className="flex items-center gap-1.5 text-xs">
                      <Switch
                        size="sm"
                        aria-label={instructionProfileItemLabel(
                          item.kind,
                          item.name || INSTRUCTION_PROFILE_ALL_ITEMS,
                        )}
                        checked={item.enabled}
                        onCheckedChange={(checked) => setItem(item.key, { enabled: checked })}
                      />
                      <span className="w-6">{item.enabled ? "On" : "Off"}</span>
                    </label>
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Remove ${instructionProfileItemLabel(item.kind, item.name || INSTRUCTION_PROFILE_ALL_ITEMS)}`}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          items: current.items.filter((entry) => entry.key !== item.key),
                        }))
                      }
                    >
                      <XIcon aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    items: [
                      ...current.items,
                      {
                        key: newProfileDraftItemKey(),
                        kind: "skill" satisfies InstructionProfileItemKind,
                        name: "",
                        enabled: false,
                      },
                    ],
                  }))
                }
              >
                <PlusIcon aria-hidden />
                Add switch
              </Button>
            </div>
          </div>

          {failure === null ? null : <p className="text-sm text-destructive">{failure}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!isNew && !changed} onClick={() => void submit()}>
              {isNew ? "Create profile" : "Save changes"}
            </Button>
            <Button size="sm" variant="outline" onClick={props.onDone}>
              Cancel
            </Button>
            {isNew ? null : (
              <Button
                size="sm"
                variant="destructive-outline"
                className="ms-auto"
                onClick={() => setConfirmDelete(true)}
              >
                Delete profile
              </Button>
            )}
          </div>
        </div>
      </fieldset>
      <AlertDialog open={confirmDelete} onOpenChange={(open) => !busy && setConfirmDelete(open)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {props.saved?.name ?? "this profile"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Threads that use it follow their project or the default again. If a project or the
              default uses it, that choice is cleared.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void deleteProfile()}>
              Delete profile
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

function ProfileSelect(props: {
  readonly label: string;
  readonly value: string | null;
  readonly profiles: ReadonlyArray<InstructionProfile>;
  readonly noneLabel: string;
  readonly disabled: boolean;
  readonly onChange: (profileId: string | null) => void;
}) {
  const value = props.value ?? NONE;
  const selected = props.profiles.find((profile) => profile.id === value);
  return (
    <Select
      value={value}
      disabled={props.disabled}
      onValueChange={(next) => {
        if (next !== null) props.onChange(next === NONE ? null : next);
      }}
    >
      <SelectTrigger
        aria-label={props.label}
        className="w-full @min-[32rem]/settings-row:w-56"
        size="sm"
      >
        <SelectValue>{selected?.name ?? props.noneLabel}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={NONE}>{props.noneLabel}</SelectItem>
        {props.profiles.map((profile) => (
          <SelectItem key={profile.id} value={profile.id}>
            {profile.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ProfileDefaults(props: {
  readonly environmentId: EnvironmentId;
  readonly profiles: ReadonlyArray<InstructionProfile>;
  readonly canEdit: boolean;
}) {
  const { environmentId } = props;
  const query = useEnvironmentQuery(
    instructionProfileEnvironment.defaults({ environmentId, input: {} }),
  );
  const setDefault = useAtomCommand(instructionProfileEnvironment.setDefault, {
    label: "set default instruction profile",
  });
  const setProject = useAtomCommand(instructionProfileEnvironment.setProject, {
    label: "set project instruction profile",
  });
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const defaults = query.data;
  const projectChoice = (projectId: ProjectId) =>
    defaults?.projects.find((entry) => entry.projectId === projectId)?.profileId ?? null;
  const defaultName =
    props.profiles.find((profile) => profile.id === defaults?.defaultProfileId)?.name ?? "None";

  if (defaults === null) {
    return (
      <SettingsSection {...searchableSetting("default-instruction-profile")}>
        {query.error !== null ? (
          <SettingsRow
            title="Could not load the default profiles"
            description={query.error}
            control={
              <Button size="xs" variant="outline" onClick={query.refresh}>
                Retry
              </Button>
            }
          />
        ) : (
          <div className="grid gap-2 px-4 py-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-8 w-full" />
          </div>
        )}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection {...searchableSetting("default-instruction-profile")}>
      <SettingsRow
        title="Every thread"
        description="Used when neither the thread nor its project picks a profile."
        control={
          <ProfileSelect
            label="Default instruction profile"
            value={defaults?.defaultProfileId ?? null}
            profiles={props.profiles}
            noneLabel="None"
            disabled={!props.canEdit}
            onChange={(profileId) => void setDefault({ environmentId, input: { profileId } })}
          />
        }
      />
      {projects.map((project) => (
        <SettingsRow
          key={project.id}
          title={project.title}
          description="Used by this project's threads that do not pick their own."
          control={
            <ProfileSelect
              label={`Instruction profile for ${project.title}`}
              value={projectChoice(project.id)}
              profiles={props.profiles}
              noneLabel={`Same as default (${defaultName})`}
              disabled={!props.canEdit}
              onChange={(profileId) =>
                void setProject({ environmentId, input: { projectId: project.id, profileId } })
              }
            />
          }
        />
      ))}
    </SettingsSection>
  );
}

function ProfileSupport({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    instructionProfileEnvironment.support({ environmentId, input: {} }),
  );
  if (query.data === null) {
    return query.error === null ? null : (
      <SettingsSection {...searchableSetting("instruction-profile-support")}>
        <SettingsRow
          title="Could not load what each agent supports"
          description={query.error}
          control={
            <Button size="xs" variant="outline" onClick={query.refresh}>
              Retry
            </Button>
          }
        />
      </SettingsSection>
    );
  }
  const rows = instructionProfileSupportRows(query.data.drivers);
  return (
    <SettingsSection {...searchableSetting("instruction-profile-support")}>
      <p className="px-4 pt-3 text-sm text-muted-foreground">
        What each part of a profile does on each agent. Choose How to see the setting T3 Code uses.
      </p>
      <div className="overflow-x-auto px-4 py-3">
        <table className="w-full min-w-[40rem] table-fixed border-collapse text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="w-36 pb-2 font-medium">Agent</th>
              {SUPPORT_COLUMNS.map((column) => (
                <th key={column.kind} className="pb-2 ps-3 font-medium">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <SupportRow key={row.key} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </SettingsSection>
  );
}

function SupportRow(props: {
  readonly row: ReturnType<typeof instructionProfileSupportRows>[number];
}) {
  const { row } = props;
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-t align-top">
        <th scope="row" className="py-2 pe-2 text-left font-medium">
          <span className="block">{row.label}</span>
          <Button size="xs" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide how" : "How"}
          </Button>
        </th>
        {SUPPORT_COLUMNS.map(({ kind }) => {
          const cell = row.cells.find((entry) => entry.kind === kind);
          if (cell === undefined) return <td key={kind} className="py-2 ps-3" />;
          return (
            <td key={kind} className="py-2 ps-3">
              <span className="flex items-start gap-1.5">
                <span
                  className={cn("mt-1 size-2 shrink-0 rounded-full", SUPPORT_DOT[cell.support])}
                  aria-hidden
                />
                <span
                  className={cell.support === "no" ? "text-muted-foreground" : "text-foreground"}
                >
                  {instructionProfileSupportResult(cell)}
                </span>
              </span>
            </td>
          );
        })}
      </tr>
      {open ? (
        <tr>
          <td colSpan={SUPPORT_COLUMNS.length + 1} className="pb-3">
            <dl className="m-0 grid gap-1 rounded-lg bg-muted/50 p-2 text-muted-foreground">
              {SUPPORT_COLUMNS.map(({ kind, label }) => {
                const cell = row.cells.find((entry) => entry.kind === kind);
                return cell === undefined ? null : (
                  <div key={kind} className="grid gap-x-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                    <dt className="font-medium text-foreground">{label}</dt>
                    <dd className="m-0 [overflow-wrap:anywhere]">{cell.how}</dd>
                  </div>
                );
              })}
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}
