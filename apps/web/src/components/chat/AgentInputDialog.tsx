import type {
  AgentInputLayer,
  AgentInputLayerKind,
  AgentInputProfileUse,
  AgentInputRequest,
  AgentInputRequestPart,
  AgentInputText,
  AgentInputTextTarget,
  EnvironmentId,
  ScopedThreadRef,
  ThreadAgentInput,
  ThreadId,
} from "@t3tools/contracts";
import { AGENT_INPUT_TEXT_MAX_CHARS } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  agentInputFidelitySentence,
  agentInputLayerWhen,
  agentInputRequestLabel,
  agentInputSizeSegments,
  agentInputTextTargetKey,
  formatAgentInputChars,
  formatAgentInputShare,
  groupAgentInputLayers,
} from "./AgentInputDialog.logic";

// Host in chat to survive command palette dismissal.
const agentInputDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("agent-input:dialog-thread"),
);

export function openAgentInputDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(agentInputDialogThreadAtom, threadRef);
}

const KIND_SWATCH: Readonly<Record<AgentInputLayerKind, string>> = {
  "system-prompt": "bg-sky-500",
  "host-instructions": "bg-violet-500",
  profile: "bg-fuchsia-500",
  "instruction-file": "bg-amber-500",
  memory: "bg-lime-500",
  skills: "bg-emerald-500",
  agents: "bg-pink-500",
  "mcp-instructions": "bg-cyan-700",
  tools: "bg-slate-400",
  environment: "bg-yellow-300",
  "hook-output": "bg-red-600",
  "user-prompt": "bg-indigo-500",
  other: "bg-zinc-500",
};

const PROFILE_STATE_LABEL: Readonly<
  Record<AgentInputProfileUse["effects"][number]["state"], string>
> = {
  applied: "Applied",
  "not-supported": "Not supported",
  unchanged: "Unchanged",
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
            What this thread's agent was given: its prompts, instructions and tools.
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
  const [target, setTarget] = useState<AgentInputTextTarget | null>(null);
  const trace = query.data;
  const selectedKey = target === null ? null : agentInputTextTargetKey(target);

  return (
    <>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 px-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto pe-1">
          {query.error !== null ? (
            <p className="text-sm text-destructive-foreground">
              Could not load the agent input: {query.error}
            </p>
          ) : trace === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <AgentInputSummary
              trace={trace}
              selectedKey={selectedKey}
              onSelect={(next) => setTarget(next)}
            />
          )}
        </div>
        <div className="flex min-h-0 flex-col pb-1">
          {target === null ? (
            <div className="flex min-h-40 flex-1 items-center justify-center rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              Choose a layer or a request part to read its full text.
            </div>
          ) : (
            <AgentInputTextPane
              key={selectedKey}
              environmentId={props.environmentId}
              threadId={props.threadId}
              target={target}
              title={trace === null ? "" : textTargetTitle(trace, target)}
            />
          )}
        </div>
      </div>
      <DialogFooter variant="bare">
        <Button size="sm" variant="outline" disabled={query.isPending} onClick={query.refresh}>
          Refresh
        </Button>
      </DialogFooter>
    </>
  );
}

function textTargetTitle(trace: ThreadAgentInput, target: AgentInputTextTarget): string {
  if (target.type === "layer") {
    return trace.layers.find((layer) => layer.id === target.layerId)?.title ?? "Layer";
  }
  return `${agentInputRequestLabel(target.index)}: ${PART_LABEL[target.part]}`;
}

function AgentInputSummary(props: {
  readonly trace: ThreadAgentInput;
  readonly selectedKey: string | null;
  readonly onSelect: (target: AgentInputTextTarget) => void;
}) {
  const { trace } = props;
  return (
    <div className="flex flex-col gap-4 pb-4">
      <section aria-label="Source" className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{trace.driver}</Badge>
          <Badge variant={trace.fidelity === "exact" ? "success" : "secondary"}>
            {trace.fidelity}
          </Badge>
          <span className="text-xs text-muted-foreground">{trace.source}</span>
        </div>
        <p className="text-sm text-foreground">{agentInputFidelitySentence(trace.fidelity)}.</p>
        {trace.notes.map((note) => (
          <p key={note} className="text-xs text-muted-foreground">
            {note}
          </p>
        ))}
      </section>

      {trace.profile === undefined ? null : <AgentInputProfileStrip profile={trace.profile} />}

      {trace.layers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No layers were recorded for this thread.</p>
      ) : (
        <>
          <AgentInputSizeBar layers={trace.layers} />
          <AgentInputLayersTable
            layers={trace.layers}
            selectedKey={props.selectedKey}
            onSelect={props.onSelect}
          />
        </>
      )}

      {trace.requests.length === 0 ? null : (
        <AgentInputRequests
          requests={trace.requests}
          selectedKey={props.selectedKey}
          onSelect={props.onSelect}
        />
      )}
    </div>
  );
}

function AgentInputProfileStrip(props: { readonly profile: AgentInputProfileUse }) {
  const { profile } = props;
  return (
    <section aria-label="Instruction profile" className="rounded-lg border p-3">
      <p className="text-sm">
        <span className="text-muted-foreground">Profile: </span>
        <span className="font-medium">{profile.profileName}</span>
        <span className="text-xs text-muted-foreground">
          {" "}
          · applied {new Date(profile.appliedAt).toLocaleString()}
        </span>
      </p>
      {profile.effects.length === 0 ? null : (
        <ul className="mt-2 flex list-none flex-col gap-1 p-0">
          {profile.effects.map((effect) => (
            <li
              key={`${effect.toggle}:${effect.name ?? ""}`}
              className="flex min-w-0 items-baseline gap-2 text-xs"
            >
              <Badge
                size="sm"
                variant={
                  effect.state === "applied"
                    ? "success"
                    : effect.state === "not-supported"
                      ? "warning"
                      : "secondary"
                }
              >
                {PROFILE_STATE_LABEL[effect.state]}
              </Badge>
              <span className="font-medium">{effect.name ?? effect.toggle}</span>
              <span className="min-w-0 text-muted-foreground">{effect.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentInputSizeBar(props: { readonly layers: ReadonlyArray<AgentInputLayer> }) {
  const segments = agentInputSizeSegments(props.layers);
  const total = segments.reduce((sum, segment) => sum + segment.chars, 0);
  if (segments.length === 0) return null;
  return (
    <section aria-label="Size by kind" className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {formatAgentInputChars(total)} characters in {props.layers.length} layers
      </p>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        {segments.map((segment) => (
          <div
            key={segment.kind}
            className={cn("h-full", KIND_SWATCH[segment.kind])}
            style={{ width: `${segment.share * 100}%` }}
          />
        ))}
      </div>
      <ul className="m-0 grid list-none grid-cols-1 gap-x-6 gap-y-1 p-0 text-xs sm:grid-cols-2">
        {segments.map((segment) => (
          <li key={segment.kind} className="flex min-w-0 items-center gap-1.5">
            <span className={cn("size-2 shrink-0 rounded-sm", KIND_SWATCH[segment.kind])} />
            <span className="truncate">{segment.label}</span>
            <span className="ms-auto shrink-0 font-mono text-muted-foreground tabular-nums">
              {formatAgentInputChars(segment.chars)} · {formatAgentInputShare(segment.share)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AgentInputLayersTable(props: {
  readonly layers: ReadonlyArray<AgentInputLayer>;
  readonly selectedKey: string | null;
  readonly onSelect: (target: AgentInputTextTarget) => void;
}) {
  const groups = groupAgentInputLayers(props.layers);
  return (
    <section aria-label="Layers">
      <table className="w-full table-fixed border-collapse text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="pb-1 font-medium">Layer</th>
            <th className="w-20 pb-1 font-medium">Origin</th>
            <th className="w-16 pb-1 text-right font-medium">Chars</th>
            <th className="w-24 pb-1 ps-3 font-medium">When</th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.kind}>
            <tr>
              <th colSpan={4} className="border-t pt-2 pb-1 text-left font-medium" scope="rowgroup">
                <span className="inline-flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-sm", KIND_SWATCH[group.kind])} />
                  {group.label}
                  <span className="font-normal text-muted-foreground">
                    · {group.layers.length} · {formatAgentInputChars(group.chars)}
                  </span>
                </span>
              </th>
            </tr>
            {group.layers.map((layer) => {
              const target = { type: "layer", layerId: layer.id } as const;
              const selected = props.selectedKey === agentInputTextTargetKey(target);
              const when = agentInputLayerWhen(layer);
              return (
                <tr
                  key={layer.id}
                  aria-selected={selected}
                  className={cn(
                    "cursor-pointer align-top hover:bg-accent/50",
                    selected && "bg-accent",
                  )}
                  onClick={() => props.onSelect(target)}
                >
                  <td className="min-w-0 py-1 pe-2">
                    <button
                      type="button"
                      className="block w-full min-w-0 truncate text-left text-foreground outline-none focus-visible:underline"
                    >
                      {layer.title || layer.preview || layer.id}
                    </button>
                    {layer.path === undefined ? null : (
                      <span className="block break-all font-mono text-2xs text-muted-foreground">
                        {layer.path}
                      </span>
                    )}
                  </td>
                  <td className="py-1 text-muted-foreground">{layer.origin}</td>
                  <td className="py-1 text-right font-mono tabular-nums">
                    {formatAgentInputChars(layer.chars)}
                  </td>
                  <td className="py-1 ps-3 text-muted-foreground">
                    {when === null
                      ? ""
                      : when.type === "request"
                        ? when.label
                        : new Date(when.at).toLocaleTimeString()}
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
              detail: `${request.messageCount} · ${formatAgentInputChars(request.messageChars)}`,
            },
          ];
          return (
            <li key={request.index} className="flex flex-col gap-1.5 rounded-lg border p-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">{agentInputRequestLabel(request.index)}</span>
                {request.model === undefined ? null : (
                  <span className="font-mono text-muted-foreground">{request.model}</span>
                )}
                <span className="text-muted-foreground">
                  {formatAgentInputChars(request.totalChars)} characters
                </span>
                {request.verified ? (
                  <Badge size="sm" variant="success">
                    Verified
                  </Badge>
                ) : null}
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

function AgentInputTextPane(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly target: AgentInputTextTarget;
  readonly title: string;
}) {
  const query = useEnvironmentQuery<AgentInputText, unknown>(
    orchestrationEnvironment.agentInputText({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, target: props.target },
    }),
  );
  const text = query.data;
  return (
    <section aria-label="Full text" className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{props.title}</h3>
        {text === null ? null : (
          <>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {text.chars.toLocaleString()} chars
            </span>
            <MessageCopyButton text={text.text} label="Copy text" />
          </>
        )}
      </div>
      {text?.truncated ? (
        <p className="text-xs text-warning-foreground">
          Truncated at {AGENT_INPUT_TEXT_MAX_CHARS.toLocaleString()} characters.
        </p>
      ) : null}
      {query.error !== null ? (
        <p className="text-sm text-destructive-foreground">
          Could not load the text: {query.error}
        </p>
      ) : text === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : text.text.length === 0 ? (
        <p className="text-sm text-muted-foreground">This part is empty.</p>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-words text-foreground">
          {text.text}
        </pre>
      )}
    </section>
  );
}
