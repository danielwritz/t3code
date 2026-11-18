import type {
  AgentInputLayer,
  AgentInputProfileUse,
  AgentInputRequest,
  AgentInputRequestPart,
  AgentInputVerification,
  AgentInputText,
  AgentInputTextTarget,
  EnvironmentId,
  ScopedThreadRef,
  ThreadAgentInput,
  ThreadId,
} from "@t3tools/contracts";
import { AGENT_INPUT_TEXT_MAX_CHARS, AgentInputNotFoundError } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { ArrowLeftIcon } from "lucide-react";
import { useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { cn } from "~/lib/utils";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { orchestrationEnvironment } from "../../state/orchestration";
import { type EnvironmentQueryView, useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Skeleton } from "../ui/skeleton";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  agentInputDriverLabel,
  agentInputKindDescription,
  agentInputOwner,
  agentInputOwnerShares,
  agentInputProfileNeedsDetails,
  agentInputProfileSentence,
  agentInputProfileTurnsOffT3,
  agentInputSummarySentence,
  type AgentInputOwner,
  type AgentInputOwnerShare,
  agentInputFidelityLabel,
  agentInputFidelitySentence,
  agentInputLayerTitle,
  agentInputLayerWhen,
  agentInputOriginLabel,
  agentInputProfileEffectRows,
  agentInputRequestLabel,
  agentInputTargetInTrace,
  agentInputTextTargetKey,
  formatAgentInputChars,
  formatAgentInputShare,
  groupAgentInputLayers,
  withRequestChecks,
} from "./AgentInputDialog.logic";

// Host in chat to survive command palette dismissal.
const agentInputDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("agent-input:dialog-thread"),
);

export function openAgentInputDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(agentInputDialogThreadAtom, threadRef);
}

const isAgentInputNotFound = Schema.is(AgentInputNotFoundError);

const OWNER_SWATCH: Readonly<Record<AgentInputOwner, string>> = {
  agent: "bg-sky-500",
  t3: "bg-violet-500",
  you: "bg-amber-500",
};

const PART_LABEL: Readonly<Record<AgentInputRequestPart, string>> = {
  system: "System",
  tools: "Tools",
  messages: "Messages",
};

export function AgentInputDialogHost() {
  const threadRef = useAtomValue(agentInputDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) appAtomRegistry.set(agentInputDialogThreadAtom, null);
      }}
    >
      <DialogPopup className="h-[min(88vh,56rem)] max-w-[1100px] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Agent input</DialogTitle>
          <DialogDescription>
            Everything this thread's agent was given, and who put each part there.
          </DialogDescription>
        </DialogHeader>
        <AgentInputContent
          key={`${threadRef.environmentId}:${threadRef.threadId}`}
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
        />
      </DialogPopup>
    </Dialog>
  );
}

function AgentInputContent(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const query = useEnvironmentQuery<ThreadAgentInput, unknown>(
    orchestrationEnvironment.agentInput({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const [chosen, setTarget] = useState<AgentInputTextTarget | null>(null);
  const target = agentInputTargetInTrace(query.data, chosen);
  const textQuery = useEnvironmentQuery<AgentInputText, unknown>(
    target === null
      ? null
      : orchestrationEnvironment.agentInputText({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, target },
        }),
  );
  // Reading a request part checks it on the server; its card shows that result too.
  const [checks, setChecks] = useState<Readonly<Record<number, AgentInputVerification>>>({});
  const readCheck = textQuery.data?.verification;
  if (target?.type === "request" && readCheck !== undefined && checks[target.index] !== readCheck) {
    setChecks({ ...checks, [target.index]: readCheck });
  }
  const trace = query.data;
  const selectedKey = target === null ? null : agentInputTextTargetKey(target);

  return (
    <>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 px-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className={cn("min-h-0 overflow-y-auto pe-1", target !== null && "max-md:hidden")}>
          {query.error !== null && trace === null ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              Could not load the agent input. {query.error}
            </p>
          ) : trace === null ? (
            <AgentInputSummarySkeleton />
          ) : (
            <AgentInputSummary
              trace={trace}
              checks={checks}
              selectedKey={selectedKey}
              onSelect={(next) => setTarget(next)}
            />
          )}
        </div>
        <div className={cn("flex min-h-0 flex-col pb-1", target === null && "max-md:hidden")}>
          {target === null ? (
            <div className="flex min-h-40 flex-1 items-center justify-center rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              Choose a layer or a request part to read its full text.
            </div>
          ) : (
            <AgentInputTextPane
              key={selectedKey}
              query={textQuery}
              title={trace === null ? "" : textTargetTitle(trace, target)}
              onBack={() => setTarget(null)}
            />
          )}
        </div>
      </div>
      <DialogFooter variant="bare">
        {query.error !== null && trace !== null ? (
          <p role="alert" className="text-xs text-destructive-foreground sm:me-auto sm:self-center">
            Could not refresh. {query.error}
          </p>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={query.isPending}
          onClick={() => {
            setChecks({});
            query.refresh();
          }}
        >
          {query.isPending && trace !== null ? "Refreshing…" : "Refresh"}
        </Button>
      </DialogFooter>
    </>
  );
}

function textTargetTitle(trace: ThreadAgentInput, target: AgentInputTextTarget): string {
  if (target.type === "layer") {
    const layer = trace.layers.find((entry) => entry.id === target.layerId);
    return layer === undefined ? "Layer" : agentInputLayerTitle(layer);
  }
  return `${agentInputRequestLabel(target.index)}: ${PART_LABEL[target.part]}`;
}

function AgentInputSummarySkeleton() {
  return (
    <div className="flex flex-col gap-3 pb-4" aria-label="Loading the agent input" role="status">
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function AgentInputSummary(props: {
  readonly trace: ThreadAgentInput;
  readonly checks: Readonly<Record<number, AgentInputVerification>>;
  readonly selectedKey: string | null;
  readonly onSelect: (target: AgentInputTextTarget) => void;
}) {
  const { trace } = props;
  const [owner, setOwner] = useState<AgentInputOwner | null>(null);
  const agentName = agentInputDriverLabel(trace.driver);
  const shares = agentInputOwnerShares(trace.layers);
  const shown =
    owner === null
      ? trace.layers
      : trace.layers.filter((layer) => agentInputOwner(layer.origin) === owner);
  return (
    <div className="flex flex-col gap-4 pb-4">
      <AgentInputSource trace={trace} agentName={agentName} />

      {trace.layers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No layers yet. They appear after the agent's next turn; then choose Refresh.
        </p>
      ) : (
        <section aria-label="Who put this there" className="flex flex-col gap-2">
          <p className="text-sm font-medium text-foreground">
            {agentInputSummarySentence(agentName, shares, trace.profile)}
          </p>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
            {shares.map((share) => (
              <div
                key={share.owner}
                className={cn("h-full", OWNER_SWATCH[share.owner])}
                style={{ width: `${share.share * 100}%` }}
              />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {shares.map((share) => (
              <AgentInputOwnerChip
                key={share.owner}
                share={share}
                agentName={agentName}
                profile={trace.profile}
                pressed={owner === share.owner}
                onPress={() => setOwner(owner === share.owner ? null : share.owner)}
              />
            ))}
          </div>
        </section>
      )}

      {trace.profile === undefined ? null : (
        <AgentInputProfileStrip profile={trace.profile} layers={trace.layers} />
      )}

      {trace.layers.length === 0 ? null : (
        <>
          {owner === null ? null : (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">
                Showing only what came from {ownerLabel(owner, agentName)}.
              </span>
              <Button size="xs" variant="outline" onClick={() => setOwner(null)}>
                Show all
              </Button>
            </div>
          )}
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing came from here.</p>
          ) : (
            <AgentInputLayersTable
              layers={shown}
              selectedKey={props.selectedKey}
              onSelect={props.onSelect}
            />
          )}
        </>
      )}

      {trace.requests.length === 0 ? null : (
        <AgentInputRequests
          requests={withRequestChecks(trace.requests, props.checks)}
          selectedKey={props.selectedKey}
          onSelect={props.onSelect}
        />
      )}
    </div>
  );
}

const ownerLabel = (owner: AgentInputOwner, agentName: string) =>
  owner === "agent" ? `${agentName} itself` : owner === "t3" ? "T3 Code" : "you";

const OWNER_DESCRIPTION: Readonly<Record<AgentInputOwner, string>> = {
  agent: "Its maker's system prompt, built-in tools, skills and agents",
  t3: "T3 Code's instructions and tools",
  you: "Your files, profile, MCP servers and messages",
};

function AgentInputOwnerChip(props: {
  readonly share: AgentInputOwnerShare;
  readonly agentName: string;
  readonly profile: AgentInputProfileUse | undefined;
  readonly pressed: boolean;
  readonly onPress: () => void;
}) {
  const { share } = props;
  const label = ownerLabel(share.owner, props.agentName);
  const switchedOff =
    share.owner === "t3" && share.chars === 0 && agentInputProfileTurnsOffT3(props.profile);
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      onClick={props.onPress}
      className={cn(
        "flex min-w-0 flex-col gap-0.5 rounded-lg border p-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        props.pressed && "border-ring bg-accent hover:bg-accent",
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium">
        <span className={cn("size-2 shrink-0 rounded-sm", OWNER_SWATCH[share.owner])} aria-hidden />
        <span className="truncate">{label.charAt(0).toUpperCase() + label.slice(1)}</span>
      </span>
      <span className="font-mono text-sm tabular-nums">
        {share.chars === 0
          ? "Nothing"
          : `${formatAgentInputChars(share.chars)} · ${formatAgentInputShare(share.share)}`}
      </span>
      <span className="text-2xs text-muted-foreground">
        {switchedOff && props.profile !== undefined
          ? `Switched off by profile "${props.profile.profileName}"`
          : OWNER_DESCRIPTION[share.owner]}
      </span>
    </button>
  );
}

function AgentInputSource(props: { readonly trace: ThreadAgentInput; readonly agentName: string }) {
  const { trace } = props;
  return (
    <section aria-label="Source" className="flex flex-col gap-1">
      <Collapsible>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{props.agentName}</Badge>
          <Badge variant={trace.fidelity === "exact" ? "success" : "secondary"}>
            {agentInputFidelityLabel(trace.fidelity)}
          </Badge>
          <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
            Where is this from?
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel>
          <p className="pt-1 text-xs text-muted-foreground">
            {agentInputFidelitySentence(trace.fidelity)}. Read from: {trace.source}.
          </p>
        </CollapsiblePanel>
      </Collapsible>
      {trace.notes.map((note) => (
        <p key={note} className="text-xs text-muted-foreground">
          {note}
        </p>
      ))}
    </section>
  );
}

function AgentInputProfileStrip(props: {
  readonly profile: AgentInputProfileUse;
  readonly layers: ReadonlyArray<AgentInputLayer>;
}) {
  const { profile } = props;
  const nowMinute = useNowMinute();
  const rows = agentInputProfileEffectRows(profile);
  const applied = formatRelativeTimeLabel(profile.appliedAt, Date.parse(`${nowMinute}:00Z`));
  return (
    <section aria-label="Instruction profile" className="rounded-lg border p-3">
      <p className="text-sm break-words">{agentInputProfileSentence(profile, props.layers)}</p>
      <Collapsible defaultOpen={agentInputProfileNeedsDetails(profile)}>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>
            Applied {applied}
            {profile.driver === undefined ? "" : ` to ${agentInputDriverLabel(profile.driver)}`}
          </span>
          {rows.length === 0 ? null : (
            <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
              Details
            </CollapsibleTrigger>
          )}
        </div>
        {rows.length === 0 ? null : (
          <CollapsiblePanel>
            <table className="mt-2 w-full table-fixed border-collapse text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-1 font-medium">Item</th>
                  <th className="w-16 pb-1 font-medium">Asked</th>
                  <th className="w-28 pb-1 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-t align-top">
                    <td className="py-1.5 pe-2">
                      <span className="block font-medium break-words">{row.item}</span>
                      {row.how === undefined ? null : (
                        <span className="block break-words text-muted-foreground">{row.how}</span>
                      )}
                      {row.reason === undefined ? null : (
                        <span className="block text-warning-foreground">{row.reason}</span>
                      )}
                    </td>
                    <td className="py-1.5 text-muted-foreground">{row.asked ?? ""}</td>
                    <td className="py-1.5">
                      <Badge size="sm" variant={row.tone}>
                        {row.result}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CollapsiblePanel>
        )}
      </Collapsible>
    </section>
  );
}

function AgentInputLayersTable(props: {
  readonly layers: ReadonlyArray<AgentInputLayer>;
  readonly selectedKey: string | null;
  readonly onSelect: (target: AgentInputTextTarget) => void;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const groups = groupAgentInputLayers(props.layers);
  return (
    <section aria-label="Layers">
      <table className="w-full table-fixed border-collapse text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="pb-1 font-medium">Layer</th>
            <th className="w-20 pb-1 font-medium max-sm:hidden">From</th>
            <th className="w-14 pb-1 text-right font-medium">Size</th>
            <th className="w-20 pb-1 ps-3 font-medium">When</th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.kind}>
            <tr>
              <th colSpan={4} className="border-t pt-2 pb-1 text-left font-medium" scope="rowgroup">
                <span className="block">
                  {group.label}
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    · {group.layers.length} · {formatAgentInputChars(group.chars)}
                  </span>
                </span>
                <span className="block font-normal text-muted-foreground">
                  {agentInputKindDescription(group.kind)}
                </span>
              </th>
            </tr>
            {group.layers.map((layer) => {
              const target = { type: "layer", layerId: layer.id } as const;
              const selected = props.selectedKey === agentInputTextTargetKey(target);
              const when = agentInputLayerWhen(layer);
              const title = agentInputLayerTitle(layer);
              return (
                <tr
                  key={layer.id}
                  className={cn(
                    "cursor-pointer align-top outline-ring -outline-offset-2 hover:bg-accent/50 has-focus-visible:outline-2",
                    selected && "bg-accent hover:bg-accent",
                  )}
                  onClick={() => props.onSelect(target)}
                >
                  <td className="min-w-0 py-1 ps-1 pe-2">
                    <button
                      type="button"
                      aria-pressed={selected}
                      className="block w-full min-w-0 truncate text-left text-foreground outline-none"
                    >
                      {title}
                    </button>
                    {layer.path === undefined ? null : (
                      <span className="block font-mono text-2xs break-all text-muted-foreground">
                        {layer.path}
                      </span>
                    )}
                  </td>
                  <td className="py-1 text-muted-foreground max-sm:hidden">
                    {agentInputOriginLabel(layer.origin)}
                  </td>
                  <td className="py-1 text-right font-mono tabular-nums">
                    {formatAgentInputChars(layer.chars)}
                  </td>
                  <td className="py-1 ps-3 pe-1 text-muted-foreground">
                    {when === null
                      ? ""
                      : when.type === "request"
                        ? when.label
                        : formatShortTimestamp(when.at, timestampFormat)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </section>
  );
}

function AgentInputRequests(props: {
  readonly requests: ReadonlyArray<AgentInputRequest>;
  readonly selectedKey: string | null;
  readonly onSelect: (target: AgentInputTextTarget) => void;
}) {
  return (
    <section aria-label="Requests" className="flex flex-col gap-2">
      <h3 className="border-t pt-2 text-xs font-medium">Requests to the model</h3>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {props.requests.map((request) => {
          const parts: ReadonlyArray<{ part: AgentInputRequestPart; detail: string }> = [
            { part: "system", detail: formatAgentInputChars(request.systemChars) },
            {
              part: "tools",
              detail: `${request.toolCount} · ${formatAgentInputChars(request.toolChars)}`,
            },
            {
              part: "messages",
              detail:
                request.messageChars === undefined
                  ? `${request.messageCount}`
                  : `${request.messageCount} · ${formatAgentInputChars(request.messageChars)}`,
            },
          ];
          return (
            <li key={request.index} className="flex flex-col gap-1.5 rounded-lg border p-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="font-medium">{agentInputRequestLabel(request.index)}</span>
                {request.model === undefined ? null : (
                  <span className="font-mono text-muted-foreground">{request.model}</span>
                )}
                {request.totalChars === undefined ? null : (
                  <span className="text-muted-foreground">
                    {formatAgentInputChars(request.totalChars)} characters
                  </span>
                )}
                <AgentInputVerificationBadge verification={request.verification} />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {parts.map(({ part, detail }) => {
                  const target = { type: "request", index: request.index, part } as const;
                  const selected = props.selectedKey === agentInputTextTargetKey(target);
                  return (
                    <Button
                      key={part}
                      size="xs"
                      variant={selected ? "secondary" : "outline"}
                      aria-pressed={selected}
                      onClick={() => props.onSelect(target)}
                    >
                      {PART_LABEL[part]}
                      <span className="font-mono text-muted-foreground">{detail}</span>
                    </Button>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function AgentInputVerificationBadge(props: { readonly verification: AgentInputVerification }) {
  if (props.verification === "verified") {
    return (
      <Badge size="sm" variant="success">
        Verified
      </Badge>
    );
  }
  if (props.verification === "not-checked") {
    return (
      <Badge size="sm" variant="outline">
        Not checked yet
      </Badge>
    );
  }
  return null;
}

function AgentInputTextPane(props: {
  readonly query: EnvironmentQueryView<AgentInputText, unknown>;
  readonly title: string;
  readonly onBack: () => void;
}) {
  const { query } = props;
  const text = query.data;
  return (
    <section aria-label="Full text" className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="md:hidden">
        <Button size="xs" variant="ghost" onClick={props.onBack}>
          <ArrowLeftIcon aria-hidden />
          All layers and requests
        </Button>
      </div>
      <div className="flex min-h-7 min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{props.title}</h3>
        {text === null ? null : (
          <>
            {text.verification === undefined ? null : (
              <AgentInputVerificationBadge verification={text.verification} />
            )}
            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
              {text.chars.toLocaleString()} characters
            </span>
            <MessageCopyButton text={text.text} label="Copy text" />
          </>
        )}
      </div>
      {text?.truncated ? (
        <p className="text-xs text-warning-foreground">
          Showing and copying the first {AGENT_INPUT_TEXT_MAX_CHARS.toLocaleString()} characters.
        </p>
      ) : null}
      {query.error !== null && text === null ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p className="text-destructive-foreground">
            {isAgentInputNotFound(query.failure)
              ? "This part is no longer in the agent's record. Choose Refresh to see the current one."
              : `Could not load the text. ${query.error}`}
          </p>
          <Button size="xs" variant="outline" onClick={query.refresh}>
            Try again
          </Button>
        </div>
      ) : text === null ? (
        <Skeleton className="min-h-40 flex-1" />
      ) : text.text.length === 0 ? (
        <p className="text-sm text-muted-foreground">This part is empty.</p>
      ) : (
        <pre
          tabIndex={0}
          aria-label={`${props.title} text`}
          className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-words text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {text.text}
        </pre>
      )}
    </section>
  );
}
