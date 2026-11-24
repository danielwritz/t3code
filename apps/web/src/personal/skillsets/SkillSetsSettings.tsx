// Settings -> Skill sets (prototype): register a repo of skills, give it a logo, keep it in sync,
// and choose which skills in it load. Reads the fixture; nothing here writes to disk yet.
import { T, useGT, useMessages, Var } from "gt-react";
import {
  ChevronRightIcon,
  FolderGit2Icon,
  GitBranchIcon,
  ImageIcon,
  PlusIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { SettingsGroup } from "~/components/settings/SettingsGroup";
import { SettingsPageContainer, SettingsSection } from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import { SkillSetLogo, syncLine } from "./SkillSetPickers";
import { useSkillSets, type SkillSet, type SkillSetSkill } from "./skillSetsStore";

const PROVIDERS = [
  { driver: "codex", name: "Codex" },
  { driver: "claudeAgent", name: "Claude" },
  { driver: "claudeAgent", name: "Claude2" },
  { driver: "antigravity", name: "Antigravity" },
] as const;
const LOGO_COLORS = [
  "bg-blue-500",
  "bg-rose-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-zinc-500",
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-3 px-4 py-2.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function SkillRow({ skill }: { skill: SkillSetSkill }) {
  const gt = useGT();
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <Switch checked={skill.enabled} aria-label={gt("Load {name}", { name: skill.name })} />
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
      <span className="w-14 shrink-0 text-right font-mono text-3xs text-muted-foreground tabular-nums">
        <T>
          ~<Var>{skill.listingTokens}</Var> tok
        </T>
      </span>
    </div>
  );
}

function SkillSetDetail({ set }: { set: SkillSet }) {
  const gt = useGT();
  const local = set.repo.state === "local";
  const logoModes = [
    gt("Repo logo"),
    gt("Monogram"),
    gt("Icon", { $context: "logo source, an icon from the icon set" }),
    gt("Upload", { $context: "logo source, an image the user uploads" }),
  ];
  return (
    <div className="border-t border-border/50 bg-muted/20">
      <Field label={gt("Logo")}>
        <SkillSetLogo logo={set.logo} className="size-9" />
        <div className="flex items-center rounded-md border border-border bg-popover p-0.5 text-xs">
          {logoModes.map((mode, index) => (
            <span
              key={mode}
              className={cn(
                "rounded-sm px-2 py-0.5",
                (set.logo.kind === "image" ? index === 0 : index === 1)
                  ? "bg-foreground/10 font-medium"
                  : "text-muted-foreground",
              )}
            >
              {mode}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {LOGO_COLORS.map((color, index) => (
            <span
              key={color}
              className={cn(
                "size-4 rounded-full",
                color,
                set.logo.kind === "monogram" && index === 0 && "ring-2 ring-ring ring-offset-1",
              )}
            />
          ))}
        </div>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <ImageIcon className="size-3.5" />
          {set.logo.kind === "image"
            ? gt("found in the repo")
            : gt("same choices as a project icon")}
        </span>
      </Field>
      <Field label={gt("Repo")}>
        <Input
          readOnly
          value={local ? (set.repo.proposed ?? "") : set.repo.label}
          size="compact"
          font="mono"
          className="w-72"
        />
        {local ? (
          <>
            <Button variant="outline" size="xs">
              <FolderGit2Icon />
              <T>Create repo and push</T>
            </Button>
            <span className="flex items-center gap-1 text-xs text-warning-foreground">
              <TriangleAlertIcon className="size-3.5" />
              <T>
                lives only in <Var>{set.repo.path}</Var>
              </T>
            </span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
              <GitBranchIcon className="size-3.5" />
              {set.repo.branch} @ {set.repo.commit}
            </span>
            {set.repo.upstream ? (
              <span className="text-xs text-muted-foreground">
                <T>
                  mirrors <Var>{set.repo.upstream}</Var>
                </T>
              </span>
            ) : null}
          </>
        )}
      </Field>
      <Field label={gt("Auto-sync")}>
        <Switch checked={!local} aria-label={gt("Auto-sync")} />
        <span className="rounded-md border border-border bg-popover px-2 py-0.5 text-xs">
          <T>every 15 minutes</T>
        </span>
        <span className="text-xs text-muted-foreground">
          {local
            ? gt("starts when the repo exists")
            : gt("pulls {branch}; a thread picks up changes on its next message", {
                branch: set.repo.branch ?? "",
              })}
        </span>
        <Button variant="outline" size="xs" className="ml-auto" disabled={local}>
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
          <span className="font-mono text-3xs text-muted-foreground">
            <T>
              ~<Var>{set.listingTokens.toLocaleString()}</Var> tokens added to every thread
            </T>
          </span>
        </div>
        <div className="max-h-80 overflow-y-auto pb-2">
          {set.skills.map((skill) => (
            <SkillRow key={skill.name} skill={skill} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function SkillSetsSettings() {
  const gt = useGT();
  const resolve = useMessages();
  const { sets, active } = useSkillSets();
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsPageContainer>
        <SettingsSection
          title={gt("Skill sets")}
          variant="plain"
          headerAction={
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <button type="button" className="cursor-pointer font-medium hover:text-foreground">
                <T>Sync all</T>
              </button>
              <span className="flex items-center gap-1">
                <RefreshCwIcon className="size-3" />
                <T>Checked 2m ago</T>
              </span>
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
            {sets.map((set) => {
              const open = openId === set.id;
              return (
                <div key={set.id}>
                  <div className="flex items-center gap-3 px-4 py-3">
                    <SkillSetLogo logo={set.logo} className="size-9" />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {set.name}
                        {set.repo.version ? (
                          <span className="font-mono text-xs font-normal text-muted-foreground">
                            <T>
                              v<Var>{set.repo.version}</Var>
                            </T>
                          </span>
                        ) : null}
                        {set.isDefault ? (
                          <Badge variant="outline" size="sm">
                            <T>Default</T>
                          </Badge>
                        ) : null}
                        {set.id === active.id ? (
                          <Badge variant="outline" size="sm">
                            <T>This thread</T>
                          </Badge>
                        ) : null}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">{set.tagline}</span>
                      <span className="flex items-center gap-1.5 font-mono text-3xs text-muted-foreground">
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            set.repo.state === "local" ? "bg-warning" : "bg-success",
                          )}
                        />
                        {set.repo.state === "local" ? set.repo.path : set.repo.label} ·{" "}
                        {syncLine(set, resolve)}
                      </span>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs">
                      <span className="font-medium tabular-nums">
                        {gt("{count, plural, one {{count} skill} other {{count} skills}}", {
                          count: set.skills.length,
                        })}
                      </span>
                      <span className="font-mono text-3xs text-muted-foreground tabular-nums">
                        <T>
                          ~<Var>{set.listingTokens.toLocaleString()}</Var> tokens
                        </T>
                      </span>
                    </div>
                    <Switch checked aria-label={gt("Enable {name}", { name: set.name })} />
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
                  {open ? <SkillSetDetail set={set} /> : null}
                </div>
              );
            })}
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[25%] border border-dashed border-border text-muted-foreground">
                <PlusIcon className="size-4" />
              </span>
              <Input
                placeholder={gt("github.com/owner/repo, or a local folder of skills")}
                size="compact"
                font="mono"
                className="flex-1"
              />
              <Button variant="outline" size="xs">
                <T>Register skill set</T>
              </Button>
            </div>
          </SettingsGroup>
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
