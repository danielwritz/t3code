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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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

const SUPPORT_BADGE: Readonly<
  Record<
    InstructionProfileSupportLevel,
    { label: string; variant: "success" | "warning" | "outline" }
  >
> = {
  yes: { label: "Yes", variant: "success" },
  partial: { label: "Partial", variant: "warning" },
  no: { label: "No", variant: "outline" },
};

const SUPPORT_COLUMNS: ReadonlyArray<{ kind: InstructionProfileEffectKind; label: string }> = [
  { kind: "global-instructions", label: "Global instructions" },
  { kind: "skill", label: "Skills" },
  { kind: "agent", label: "Agents" },
  { kind: "mcpServer", label: "MCP servers" },
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
          A profile sets what an agent receives: one text of global instructions for every agent,
          and switches for skills, agents and MCP servers. It is applied when the agent session
          starts or resumes. Your own files are never changed.
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
          onDone={() => setDraft(null)}
        />
      )}

      <ProfileDefaults environmentId={environmentId} profiles={profiles} canEdit={canEdit} />
      <ProfileSupport environmentId={environmentId} />
    </>
  );
}

function profileSummary(profile: InstructionProfile): string {
  const parts = [
    profile.description.trim(),
    profile.globalInstructions.trim().length === 0
      ? "No global instructions"
      : `Global instructions: ${profile.globalInstructions.trim().length.toLocaleString()} characters`,
    profile.items.length === 0
      ? "no switches"
      : profile.items
          .map(
            (item) =>
              `${instructionProfileItemLabel(item.kind, item.name)} ${item.enabled ? "on" : "off"}`,
          )
          .join(", "),
  ].filter((part) => part.length > 0);
  return parts.join(" · ");
}

function ProfileEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly initial: ProfileDraft;
  readonly saved: InstructionProfile | undefined;
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
    const result = profileDraftSaveInput(draft);
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
        <div className="grid gap-4 px-4 py-4">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Name</span>
            <Input
              size="sm"
              value={draft.name}
              placeholder="Bottom-up replies"
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
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Global instructions</span>
            <span className="text-xs text-muted-foreground">
              Sent to every agent, after T3 Code's own instructions.
            </span>
            <Textarea
              rows={8}
              value={draft.globalInstructions}
              placeholder="Write chat replies bottom-up."
              onChange={(event) => setDraft({ ...draft, globalInstructions: event.target.value })}
            />
          </label>

          <div className="grid gap-2 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">Switches</span>
              <span className="text-xs text-muted-foreground">
                Use * as the name to switch every item of that kind.
              </span>
            </div>
            {draft.items.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No switches. The agent keeps all its skills, agents and MCP servers.
              </p>
            ) : (
              <ul className="m-0 grid list-none gap-2 p-0">
                {draft.items.map((item) => (
                  <li key={item.key} className="flex flex-wrap items-center gap-2">
                    <Select
                      value={item.kind}
                      onValueChange={(next) => {
                        if (next !== null) setItem(item.key, { kind: next });
                      }}
                    >
                      <SelectTrigger aria-label="Switch kind" className="w-36" size="sm">
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
                      className="min-w-0 flex-1"
                      aria-label="Switch name"
                      value={item.name}
                      placeholder="Name, or * for all"
                      onChange={(event) => setItem(item.key, { name: event.target.value })}
                    />
                    <label className="flex items-center gap-1.5 text-xs">
                      <Switch
                        size="sm"
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
              Threads and projects that use it go back to the default profile, or to none.
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
            disabled={!props.canEdit || defaults === null}
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
              noneLabel={`Default (${defaultName})`}
              disabled={!props.canEdit || defaults === null}
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
  if (query.data === null) return null;
  const rows = instructionProfileSupportRows(query.data.drivers);
  return (
    <SettingsSection {...searchableSetting("instruction-profile-support")}>
      <p className="px-4 pt-3 text-sm text-muted-foreground">
        Where an agent has no switch, the item shows "Not supported" in that thread's Agent input.
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
              <tr key={row.key} className="border-t align-top">
                <th scope="row" className="py-2 pe-2 text-left font-medium">
                  {row.label}
                </th>
                {SUPPORT_COLUMNS.map(({ kind }) => {
                  const cell = row.cells.find((entry) => entry.kind === kind);
                  if (cell === undefined) return <td key={kind} className="py-2 ps-3" />;
                  const badge = SUPPORT_BADGE[cell.support];
                  return (
                    <td key={kind} className="py-2 ps-3">
                      <Badge size="sm" variant={badge.variant}>
                        {badge.label}
                      </Badge>
                      <span className="mt-1 block break-words text-muted-foreground">
                        {cell.how}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SettingsSection>
  );
}
