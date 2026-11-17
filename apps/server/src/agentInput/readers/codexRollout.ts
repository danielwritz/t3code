import type { AgentInputLayerKind, AgentInputOrigin } from "@t3tools/contracts";

import {
  isRecord,
  makeLayer,
  makeTextLength,
  parseJsonLine,
  prettyJson,
  stringField,
  type HarnessTrace,
  type TraceLayer,
  type TraceRequest,
} from "./traceParts.ts";

const HARNESS_DEVELOPER_TAGS = [
  "permissions",
  "collaboration_mode",
  "tools",
  "recommended_plugins",
  "multi_agent_",
];

const leadingTag = (text: string) => /^\s*<([A-Za-z][\w-]*)/.exec(text)?.[1];

function classifyDeveloperText(text: string): {
  readonly kind: AgentInputLayerKind;
  readonly origin: AgentInputOrigin;
  readonly title: string;
} {
  const tag = leadingTag(text);
  if (tag === undefined)
    return { kind: "system-prompt", origin: "harness", title: "Developer message" };
  if (tag === "skills_instructions") return { kind: "skills", origin: "harness", title: "Skills" };
  if (tag.startsWith("t3_code_instruction_profile"))
    return { kind: "profile", origin: "profile", title: "Instruction profile" };
  if (tag.startsWith("t3_code_")) return { kind: "host-instructions", origin: "t3", title: tag };
  if (
    HARNESS_DEVELOPER_TAGS.some(
      (known) => tag === known || (known.endsWith("_") && tag.startsWith(known)),
    )
  ) {
    return { kind: "system-prompt", origin: "harness", title: tag };
  }
  return { kind: "other", origin: "harness", title: tag };
}

const partsOf = (content: unknown) =>
  (Array.isArray(content) ? content : [])
    .map((part) => stringField(part, "text"))
    .filter((text): text is string => text !== undefined && text.length > 0);

interface PendingLayer {
  readonly id: string;
  readonly kind: AgentInputLayerKind;
  readonly origin: AgentInputOrigin;
  readonly title: string;
  readonly text: string;
  readonly role?: "system" | "developer" | "user";
  readonly agentsMd?: true;
  readonly usageRecordsBefore: number;
  readonly turnsBefore: number;
  readonly at?: string | undefined;
}

/** Reads a Codex rollout (`rollout-*.jsonl`) line by line. */
export function makeCodexRolloutReader() {
  const pending: Array<PendingLayer> = [];
  const seen = new Set<string>();
  const items: Array<Record<string, unknown>> = [];
  const developerTexts: Array<string> = [];
  let tools: Array<unknown> = [];
  let baseInstructions: string | undefined;
  let agentsMdDirectory: string | undefined;
  let model: string | undefined;
  let lineCount = 0;
  const snapshots: Array<{
    readonly at?: string | undefined;
    readonly model?: string | undefined;
    readonly itemCount: number;
    readonly developerCount: number;
    readonly tools: ReadonlyArray<unknown>;
  }> = [];
  let sawUsageRecord = false;
  const turnEnds: Array<(typeof snapshots)[number]> = [];

  const snapshot = (at: string | undefined) => ({
    at,
    model,
    itemCount: items.length,
    developerCount: developerTexts.length,
    tools,
  });

  const push = (layer: Omit<PendingLayer, "usageRecordsBefore" | "turnsBefore">) => {
    // Codex resends its context each turn; the first copy is the one that matters.
    const key = `${layer.kind}\0${layer.title}\0${layer.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    pending.push({ ...layer, usageRecordsBefore: snapshots.length, turnsBefore: turnEnds.length });
  };

  const accept = (line: string) => {
    lineCount++;
    const record = parseJsonLine(line);
    if (!isRecord(record)) return;
    const at = stringField(record, "timestamp");
    const payload = isRecord(record.payload) ? record.payload : {};
    switch (record.type) {
      case "session_meta": {
        const text = stringField(payload.base_instructions, "text");
        if (text !== undefined && baseInstructions === undefined) {
          baseInstructions = text;
          push({
            id: "base-instructions",
            kind: "system-prompt",
            origin: "harness",
            title: "Base instructions",
            text,
            role: "system",
            at: stringField(payload, "timestamp") ?? at,
          });
        }
        return;
      }
      case "world_state": {
        const directory = stringField(
          isRecord(payload.state) ? payload.state.agents_md : undefined,
          "directory",
        );
        if (directory !== undefined) agentsMdDirectory ??= directory;
        return;
      }
      case "turn_context":
        model = stringField(payload, "model") ?? model;
        return;
      case "token_usage_record":
        sawUsageRecord = true;
        snapshots.push(snapshot(at));
        return;
      case "event_msg":
        if (payload.type === "task_complete") turnEnds.push(snapshot(at));
        return;
      case "response_item":
        break;
      default:
        return;
    }
    if (payload.type === "additional_tools") {
      tools = Array.isArray(payload.tools) ? payload.tools : [];
      const count = tools.reduce<number>(
        (total, tool) =>
          total + (isRecord(tool) && Array.isArray(tool.tools) ? tool.tools.length : 1),
        0,
      );
      push({
        id: `tools:${lineCount}`,
        kind: "tools",
        origin: "harness",
        title: `Tools (${count})`,
        text: prettyJson(tools),
        at,
      });
      return;
    }
    if (payload.type === "message" && payload.role === "developer") {
      partsOf(payload.content).forEach((text, index) => {
        developerTexts.push(text);
        if (text === baseInstructions) return;
        push({
          id: `developer:${lineCount}:${index}`,
          ...classifyDeveloperText(text),
          text,
          role: "developer",
          at,
        });
      });
      return;
    }
    items.push(payload);
    if (payload.type === "message" && payload.role === "user") {
      partsOf(payload.content).forEach((text, index) => {
        const id = `user:${lineCount}:${index}`;
        if (text.startsWith("# AGENTS.md instructions")) {
          push({
            id,
            kind: "instruction-file",
            origin: "user-file",
            title: "AGENTS.md",
            text,
            role: "user",
            agentsMd: true,
            at,
          });
        } else if (leadingTag(text) === "environment_context") {
          push({
            id,
            kind: "environment",
            origin: "harness",
            title: "Environment",
            text,
            role: "user",
            at,
          });
        } else {
          push({
            id,
            kind: "user-prompt",
            origin: "user",
            title: "User message",
            text,
            role: "user",
            at,
          });
        }
      });
    }
  };

  const finish = (): HarnessTrace => {
    const textLength = makeTextLength();
    const requestPoints = sawUsageRecord
      ? snapshots
      : turnEnds.length > 0
        ? turnEnds
        : items.length > 0
          ? [snapshot(undefined)]
          : [];
    const systemTextOf = (point: (typeof requestPoints)[number]) =>
      [
        baseInstructions ?? "",
        ...developerTexts
          .slice(0, point.developerCount)
          .filter((text) => text !== baseInstructions),
      ]
        .filter((text) => text.length > 0)
        .join("\n\n");
    const requests: Array<TraceRequest> = requestPoints.map((point, index) => {
      const messages = items.slice(0, point.itemCount);
      const systemChars = systemTextOf(point).length;
      const toolChars = textLength(point.tools);
      const messageChars = messages.reduce<number>((total, item) => total + textLength(item), 0);
      return {
        index,
        ...(point.at === undefined ? {} : { at: point.at }),
        ...(point.model === undefined ? {} : { model: point.model }),
        systemChars,
        toolCount: point.tools.reduce<number>(
          (total, tool) =>
            total + (isRecord(tool) && Array.isArray(tool.tools) ? tool.tools.length : 1),
          0,
        ),
        toolChars,
        messageCount: messages.length,
        messageChars,
        totalChars: systemChars + toolChars + messageChars,
        verified: false,
        partText: (part) =>
          part === "system"
            ? systemTextOf(point)
            : prettyJson(part === "tools" ? point.tools : items.slice(0, point.itemCount)),
      };
    });
    const layers: Array<TraceLayer> = pending.map(
      ({ usageRecordsBefore, turnsBefore, agentsMd, ...layer }) => {
        const requestsBefore = sawUsageRecord ? usageRecordsBefore : turnsBefore;
        return makeLayer({
          ...layer,
          ...(agentsMd && agentsMdDirectory !== undefined ? { path: agentsMdDirectory } : {}),
          requestIndex: requestsBefore < requests.length ? requestsBefore : undefined,
        });
      },
    );
    return {
      fidelity: "harness-record",
      layers,
      requests,
      notes: [
        "Codex does not store the schemas of deferred MCP tools; they are missing from the tool list.",
        ...(sawUsageRecord
          ? []
          : ["Codex recorded no token usage; requests are counted per turn."]),
      ],
    };
  };

  return { accept, finish };
}

export function readCodexRolloutLines(lines: ReadonlyArray<string>): HarnessTrace {
  const reader = makeCodexRolloutReader();
  for (const line of lines) reader.accept(line);
  return reader.finish();
}
