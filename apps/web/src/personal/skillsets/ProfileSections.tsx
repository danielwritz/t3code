import { T, useGT } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { SkillSetConfig } from "@t3tools/contracts";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { SettingsSection } from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Switch } from "~/components/ui/switch";
import type { SkillSet, SkillSetSkill } from "./skillSetsStore";
import {
  PROFILE_PROVIDERS,
  hookFile,
  hookKey,
  instructionsFor,
  pluginKey,
  setProfileEntryOn,
  useProfileEntryOn,
  type ProfileHook,
  type ProfileParts,
  type ProfilePlugin,
} from "./profileParts";

type Provider = (typeof PROFILE_PROVIDERS)[number];

interface Detail {
  readonly title: string;
  readonly kind: string;
  readonly fields: ReadonlyArray<readonly [string, string, "mono"?]>;
  readonly text?: { readonly label: string; readonly body: string } | undefined;
}

/** What a row is and where it comes from, opened by clicking the row. */
function DetailDialog({ detail, close }: { detail: Detail | null; close: () => void }) {
  return (
    <Dialog open={detail !== null} onOpenChange={(open) => (open ? null : close())}>
      <DialogPopup className="w-full sm:max-w-2xl">
        {detail ? (
          <>
            <DialogHeader>
              <DialogTitle>{detail.title}</DialogTitle>
              <DialogDescription>{detail.kind}</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex min-h-0 flex-col gap-4">
                <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                  {detail.fields.map(([label, value, mono]) => (
                    <div key={label} className="contents">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd
                        className={
                          mono ? "min-w-0 font-mono text-xs break-all" : "min-w-0 break-words"
                        }
                      >
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
                {detail.text ? (
                  <div className="flex min-h-0 flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {detail.text.label}
                    </span>
                    <pre className="max-h-80 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-xs break-all whitespace-pre-wrap">
                      {detail.text.body}
                    </pre>
                  </div>
                ) : null}
              </div>
            </DialogPanel>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function ProviderLabel({ provider }: { provider: Provider }) {
  return (
    <span className="flex items-center gap-2 text-sm">
      <ProviderInstanceIcon
        driverKind={provider.driver as never}
        displayName={provider.name}
        className="size-4"
        iconClassName="size-3.5"
      />
      {provider.name}
    </span>
  );
}

function Nothing({ children }: { children: ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>;
}

function Note({ children }: { children: ReactNode }) {
  return <p className="px-4 py-2.5 text-xs text-muted-foreground">{children}</p>;
}

/** One entry: an optional switch, then a clickable title and line that opens its detail. */
function EntryRow({
  title,
  line,
  badge,
  label,
  open,
  toggle,
}: {
  title: ReactNode;
  line?: ReactNode;
  badge?: ReactNode;
  label: string;
  open: () => void;
  toggle?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-1.5">
      {toggle}
      <button
        type="button"
        aria-label={label}
        onClick={open}
        className="-mx-2 flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md px-2 py-1 text-left hover:bg-foreground/4"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 font-mono text-xs font-medium">
            {title}
            {badge}
          </span>
          {line ? <span className="truncate text-xs text-muted-foreground">{line}</span> : null}
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>
  );
}

function ProviderHeader({ provider, children }: { provider: Provider; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-muted/30 px-4 py-2">
      <ProviderLabel provider={provider} />
      {children}
    </div>
  );
}

export function InstructionsSection({ parts }: { parts: ProfileParts }) {
  const gt = useGT();
  const [detail, setDetail] = useState<Detail | null>(null);
  return (
    <SettingsSection title={gt("Instructions")}>
      {PROFILE_PROVIDERS.map((provider) => {
        const file = instructionsFor(parts, provider.driver);
        return (
          <div
            key={provider.driver}
            className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-3 px-4 py-1.5"
          >
            <ProviderLabel provider={provider} />
            {file ? (
              <EntryRow
                title={file.file}
                badge={
                  <span className="font-sans font-normal text-muted-foreground">
                    {gt("{count, plural, one {{count} line} other {{count} lines}}", {
                      count: file.lines,
                    })}
                  </span>
                }
                line={file.preview}
                label={gt("Show {name} for {provider}", {
                  name: file.file,
                  provider: provider.name,
                })}
                open={() =>
                  setDetail({
                    title: file.file,
                    kind: gt("Global instructions for {provider}", { provider: provider.name }),
                    fields: [
                      [gt("File"), file.path ?? file.file, "mono"],
                      [
                        gt("Length"),
                        gt("{count, plural, one {{count} line} other {{count} lines}}", {
                          count: file.lines,
                        }),
                      ],
                    ],
                    text: { label: file.file, body: file.text ?? file.preview },
                  })
                }
              />
            ) : (
              <Nothing>
                <T>None. No global instructions load.</T>
              </Nothing>
            )}
          </div>
        );
      })}
      <DetailDialog detail={detail} close={() => setDetail(null)} />
    </SettingsSection>
  );
}

export function SkillsSection({
  set,
  parts,
  readOnly,
  update,
}: {
  set: SkillSet;
  parts: ProfileParts;
  readOnly: boolean;
  update: (patch: Partial<SkillSetConfig>) => void;
}) {
  const gt = useGT();
  const [detail, setDetail] = useState<Detail | null>(null);
  const loading = set.skills.filter((skill) => skill.enabled).length;
  const showSkill = (skill: SkillSetSkill) =>
    setDetail({
      title: skill.name,
      kind: gt("Skill"),
      fields: [
        [gt("Description"), skill.description],
        [gt("Source"), skill.targetPath, "mono"],
        [
          gt("Starts"),
          skill.manualOnly
            ? gt("Only as a /command")
            : gt("When the agent sees it fits, or as a /command"),
        ],
        [gt("Loads for"), gt("Claude, Codex and Antigravity")],
      ],
      text: parts.skillDocs?.[skill.name]
        ? { label: gt("SKILL.md"), body: parts.skillDocs[skill.name]! }
        : undefined,
    });
  return (
    <SettingsSection
      title={gt("Skills")}
      headerAction={
        <span className="text-xs text-muted-foreground">
          {gt("{count} of {total} load", { count: loading, total: set.skills.length })}
        </span>
      }
    >
      <Note>
        <T>
          The same skills for Claude, Codex and Antigravity, plus the skills built into each CLI.
        </T>
      </Note>
      {set.skills.length === 0 ? (
        <Note>
          <T>No skills of its own.</T>
        </Note>
      ) : (
        <div className="max-h-80 overflow-y-auto py-1">
          {set.skills.map((skill) => (
            <EntryRow
              key={skill.name}
              title={skill.name}
              badge={
                skill.manualOnly ? (
                  <span className="rounded-sm border border-border px-1 font-sans text-3xs font-normal text-muted-foreground">
                    <T>/command only</T>
                  </span>
                ) : null
              }
              line={skill.description}
              label={gt("Show {name}", { name: skill.name })}
              open={() => showSkill(skill)}
              toggle={
                <Switch
                  checked={skill.enabled}
                  disabled={readOnly}
                  aria-label={gt("Load {name}", { name: skill.name })}
                  onCheckedChange={(enabled) =>
                    update({
                      disabledSkills: enabled
                        ? set.disabledSkills.filter((name) => name !== skill.name)
                        : [...new Set([...set.disabledSkills, skill.name])],
                    })
                  }
                />
              }
            />
          ))}
        </div>
      )}
      <DetailDialog detail={detail} close={() => setDetail(null)} />
    </SettingsSection>
  );
}

function OnCount({ on, total }: { on: number; total: number }) {
  const gt = useGT();
  return (
    <span className="text-xs text-muted-foreground">{gt("{on} of {total} on", { on, total })}</span>
  );
}

export function PluginsSection({
  profileId,
  parts,
  readOnly,
}: {
  profileId: string;
  parts: ProfileParts;
  readOnly: boolean;
}) {
  const gt = useGT();
  const isOn = useProfileEntryOn(profileId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const list = (items: readonly string[] | undefined) =>
    items && items.length > 0 ? items.join(", ") : gt("None");
  const showPlugin = (provider: Provider, plugin: ProfilePlugin) =>
    setDetail({
      title: plugin.id,
      kind: gt("Plugin for {provider}", { provider: provider.name }),
      fields: [
        [gt("Description"), plugin.description || gt("No description")],
        [gt("Version"), plugin.version ?? gt("Unknown"), "mono"],
        [gt("Source"), plugin.source ?? plugin.id, "mono"],
        ...(plugin.path ? [[gt("Installed in"), plugin.path, "mono"] as const] : []),
        [gt("Adds skills"), list(plugin.adds?.skills)],
        [gt("Adds commands"), list(plugin.adds?.commands)],
        [gt("Adds agents"), list(plugin.adds?.agents)],
        [gt("Adds hooks"), list(plugin.adds?.hooks)],
        [gt("Adds MCP servers"), list(plugin.adds?.mcpServers)],
      ],
    });
  return (
    <SettingsSection title={gt("Plugins")}>
      {PROFILE_PROVIDERS.map((provider) => {
        const plugins = parts.plugins[provider.driver] ?? [];
        const on = plugins.filter((plugin) => isOn(pluginKey(provider.driver, plugin.id))).length;
        return (
          <div key={provider.driver}>
            <ProviderHeader provider={provider}>
              {plugins.length > 0 ? (
                <OnCount on={on} total={plugins.length} />
              ) : (
                <Nothing>
                  <T>None</T>
                </Nothing>
              )}
            </ProviderHeader>
            {plugins.map((plugin) => {
              const key = pluginKey(provider.driver, plugin.id);
              return (
                <EntryRow
                  key={key}
                  title={plugin.id}
                  badge={
                    plugin.version ? (
                      <span className="font-normal text-muted-foreground">{plugin.version}</span>
                    ) : null
                  }
                  line={plugin.description}
                  label={gt("Show {name} for {provider}", {
                    name: plugin.id,
                    provider: provider.name,
                  })}
                  open={() => showPlugin(provider, plugin)}
                  toggle={
                    <Switch
                      checked={isOn(key)}
                      disabled={readOnly}
                      aria-label={gt("Use {name} with {provider}", {
                        name: plugin.id,
                        provider: provider.name,
                      })}
                      onCheckedChange={(checked) => setProfileEntryOn(profileId, key, checked)}
                    />
                  }
                />
              );
            })}
          </div>
        );
      })}
      <DetailDialog detail={detail} close={() => setDetail(null)} />
    </SettingsSection>
  );
}

const hookTitle = (hook: ProfileHook) =>
  hook.matcher ? `${hook.event} · ${hook.matcher}` : hook.event;

export function HooksSection({
  profileId,
  parts,
  readOnly,
}: {
  profileId: string;
  parts: ProfileParts;
  readOnly: boolean;
}) {
  const gt = useGT();
  const isOn = useProfileEntryOn(profileId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const showHook = (provider: Provider, hook: ProfileHook) =>
    setDetail({
      title: hook.event,
      kind: gt("Hook for {provider}", { provider: provider.name }),
      fields: [
        [gt("Event"), hook.event],
        [gt("Matches"), hook.matcher ?? gt("Every call"), "mono"],
        ...(hook.timeout
          ? [[gt("Time limit"), gt("{count} seconds", { count: hook.timeout })] as const]
          : []),
        [gt("From"), hookFile(provider.driver), "mono"],
      ],
      text: { label: gt("Command"), body: hook.command },
    });
  return (
    <SettingsSection title={gt("Hooks")}>
      <Note>
        <T>
          Hooks are off unless this profile adds them. Without one, no hook runs, safety guards
          included.
        </T>
      </Note>
      {PROFILE_PROVIDERS.map((provider) => {
        const hooks = parts.hooks[provider.driver] ?? [];
        const on = hooks.filter((_, index) => isOn(hookKey(provider.driver, index))).length;
        return (
          <div key={provider.driver}>
            <ProviderHeader provider={provider}>
              {hooks.length > 0 ? (
                <OnCount on={on} total={hooks.length} />
              ) : (
                <Nothing>
                  <T>Off</T>
                </Nothing>
              )}
            </ProviderHeader>
            {hooks.map((hook, index) => {
              const key = hookKey(provider.driver, index);
              return (
                <EntryRow
                  key={key}
                  title={<span className="font-sans">{hookTitle(hook)}</span>}
                  line={<span className="font-mono">{hook.command}</span>}
                  label={gt("Show {event} hook {number} for {provider}", {
                    event: hook.event,
                    number: index + 1,
                    provider: provider.name,
                  })}
                  open={() => showHook(provider, hook)}
                  toggle={
                    <Switch
                      checked={isOn(key)}
                      disabled={readOnly}
                      aria-label={gt("Run {event} hook {number} for {provider}", {
                        event: hook.event,
                        number: index + 1,
                        provider: provider.name,
                      })}
                      onCheckedChange={(checked) => setProfileEntryOn(profileId, key, checked)}
                    />
                  }
                />
              );
            })}
          </div>
        );
      })}
      <DetailDialog detail={detail} close={() => setDetail(null)} />
    </SettingsSection>
  );
}

export function McpSection({ parts }: { parts: ProfileParts }) {
  const gt = useGT();
  const [detail, setDetail] = useState<Detail | null>(null);
  return (
    <SettingsSection title={gt("MCP servers")}>
      <Note>
        <T>
          One list, given to Claude, Codex and Antigravity in each one's own format. T3 Code's own
          tools are always added.
        </T>
      </Note>
      {parts.mcp.length === 0 ? (
        <Note>
          <T>None besides T3 Code's own tools.</T>
        </Note>
      ) : (
        parts.mcp.map((server) => (
          <EntryRow
            key={server.name}
            title={server.name}
            badge={
              <Badge variant="outline" size="sm">
                {server.transport}
              </Badge>
            }
            line={<span className="font-mono">{server.target}</span>}
            label={gt("Show {name}", { name: server.name })}
            open={() =>
              setDetail({
                title: server.name,
                kind: gt("MCP server"),
                fields: [
                  [gt("Transport"), server.transport],
                  [server.transport === "http" ? gt("URL") : gt("Command"), server.target, "mono"],
                  [
                    gt("Arguments"),
                    server.args && server.args.length > 0 ? server.args.join(" ") : gt("None"),
                  ],
                  [gt("Given to"), PROFILE_PROVIDERS.map((provider) => provider.name).join(", ")],
                  [gt("From"), "mcp.json", "mono"],
                ],
              })
            }
          />
        ))
      )}
      <DetailDialog detail={detail} close={() => setDetail(null)} />
    </SettingsSection>
  );
}
