// @effect-diagnostics nodeBuiltinImport:off -- request digests hash many messages synchronously.
import * as NodeCrypto from "node:crypto";

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

// Rebuilds the Messages API requests Claude Code (2.1.300+) records in its transcript:
// messages(N) = messages(base)[0:keep] ++ tail, system and tools from the shape, then
// `cacheControl` paths. Every hash is sha256 of key-sorted JSON.stringify, so each rebuilt
// message and each request body is checked against the digest the harness stored.

type Json = unknown;
type Message = Record<string, Json>;

interface ApiRequestRecord {
  readonly id: string;
  readonly timestamp?: string | undefined;
  readonly base?: string | undefined;
  readonly keep?: number | undefined;
  readonly tail: ReadonlyArray<string>;
  readonly shapeHash?: string | undefined;
  readonly params: Record<string, Json>;
  readonly cacheControl: ReadonlyArray<{
    readonly path: ReadonlyArray<string | number>;
    readonly value: Json;
  }>;
  readonly requestDigest?: string | undefined;
}

interface Shape {
  readonly system: Json;
  readonly tools: Json;
}

/** Mirrors `JSON.stringify(sortKeysDeep(value))` and memoizes each object's text. */
function makeCanonicalJson() {
  const cache = new WeakMap<object, string>();
  const canonical = (value: Json): string | undefined => {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") return JSON.stringify(value);
    if (typeof value !== "object") return undefined;
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
    let text: string;
    if (Array.isArray(value)) {
      text = `[${value.map((item) => canonical(item) ?? "null").join(",")}]`;
    } else {
      const parts: Array<string> = [];
      for (const key of Object.keys(value).sort()) {
        const item = canonical((value as Record<string, Json>)[key]);
        if (item !== undefined) parts.push(`${JSON.stringify(key)}:${item}`);
      }
      text = `{${parts.join(",")}}`;
    }
    cache.set(value, text);
    return text;
  };
  return (value: Json) =>
    NodeCrypto.createHash("sha256")
      .update(canonical(value) ?? "")
      .digest("hex");
}

const asContentArray = (content: Json): Array<Json> =>
  Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];

function setCacheControl(
  root: Record<string, Json>,
  path: ReadonlyArray<string | number>,
  value: Json,
) {
  let node: Json = root;
  for (let index = 0; index < path.length; index++) {
    const key = path[index]!;
    if (node === null || typeof node !== "object") return false;
    const container = node as Record<string | number, Json>;
    if (index === path.length - 1) {
      const target = container[key];
      if (target === null || typeof target !== "object") return false;
      container[key] = { ...(target as object), cache_control: value };
      return true;
    }
    // Copy on write: messages are shared between requests.
    const next = container[key];
    container[key] = Array.isArray(next) ? [...next] : { ...(next as object) };
    node = container[key];
  }
  return false;
}

const T3_SYSTEM_TAGS = ["<runtime_info>", "<pull_request_linking>", "<t3_code_"];
const INSTRUCTION_PROFILE_BLOCK =
  /<instruction_profile(?: name="([^"]*)")?>[\s\S]*?<\/instruction_profile>/;

const firstT3Tag = (text: string) => {
  const indexes = T3_SYSTEM_TAGS.map((tag) => text.indexOf(tag)).filter((index) => index >= 0);
  return indexes.length === 0 ? -1 : Math.min(...indexes);
};

const textOfBlocks = (blocks: Json) =>
  Array.isArray(blocks)
    ? blocks
        .map((block) => stringField(block, "text") ?? "")
        .filter((text) => text.length > 0)
        .join("\n\n")
    : typeof blocks === "string"
      ? blocks
      : "";

const isToolResultContent = (content: Json) =>
  Array.isArray(content) &&
  content.some((block) => isRecord(block) && block.type === "tool_result");

interface PendingLayer {
  readonly id: string;
  readonly kind: AgentInputLayerKind;
  readonly origin: AgentInputOrigin;
  readonly title: string;
  readonly text: string;
  readonly path?: string | undefined;
  readonly role?: "system" | "developer" | "user";
  /** Number of requests recorded before this line; the next one is the first to carry it. */
  readonly requestsBefore: number;
  readonly at?: string | undefined;
}

const basename = (filePath: string) => filePath.split(/[\\/]/).pop() ?? filePath;

const joinText = (value: Json) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").join("\n")
    : typeof value === "string"
      ? value
      : value === undefined
        ? ""
        : prettyJson(value);

/** Maps one `attachment` record to the layers it adds to the conversation. */
function attachmentLayers(
  attachment: Record<string, Json>,
  id: string,
): ReadonlyArray<Omit<PendingLayer, "requestsBefore" | "at">> {
  const rendered = Array.isArray(attachment.rendered)
    ? attachment.rendered
        .map((item) => stringField(item, "content") ?? "")
        .filter((text) => text.length > 0)
        .join("\n\n")
    : "";
  const textOr = (fallback: string) => (rendered.length > 0 ? rendered : fallback);
  switch (attachment.type) {
    case "instructions": {
      const files = Array.isArray(attachment.files) ? attachment.files : [];
      return files.flatMap((file, index) => {
        if (!isRecord(file)) return [];
        const filePath = stringField(file, "path");
        const type = stringField(file, "type");
        return [
          {
            id: `${id}:${index}`,
            kind: "instruction-file" as const,
            origin: "user-file" as const,
            title: `${filePath === undefined ? "Instructions" : basename(filePath)}${type ? ` (${type})` : ""}`,
            text: stringField(file, "content") ?? "",
            path: filePath,
            role: "user" as const,
          },
        ];
      });
    }
    case "nested_memory": {
      const content = attachment.content;
      const filePath = stringField(attachment, "path") ?? stringField(content, "path");
      return [
        {
          id,
          kind: "memory",
          origin: "user-file",
          title: filePath === undefined ? "Nested memory" : basename(filePath),
          text: textOr(
            typeof content === "string" ? content : (stringField(content, "content") ?? ""),
          ),
          path: filePath,
          role: "user",
        },
      ];
    }
    case "skill_listing":
      return [
        {
          id,
          kind: "skills",
          origin: "harness",
          title: "Skills",
          text: textOr(stringField(attachment, "content") ?? ""),
          role: "system",
        },
      ];
    case "agent_listing_delta":
      return [
        {
          id,
          kind: "agents",
          origin: "harness",
          title: "Agents",
          text: textOr(joinText(attachment.addedLines)),
          role: "system",
        },
      ];
    case "mcp_instructions_delta": {
      const names = Array.isArray(attachment.addedNames) ? attachment.addedNames : [];
      const blocks = Array.isArray(attachment.addedBlocks) ? attachment.addedBlocks : [];
      return names.map((name, index) => ({
        id: `${id}:${index}`,
        kind: "mcp-instructions" as const,
        origin: "mcp-server" as const,
        title: typeof name === "string" ? name : "MCP server",
        text: typeof blocks[index] === "string" ? (blocks[index] as string) : "",
        role: "system" as const,
      }));
    }
    case "deferred_tools_delta": {
      const added = Array.isArray(attachment.addedNames) ? attachment.addedNames.length : 0;
      return [
        {
          id,
          kind: "tools",
          origin: "harness",
          title: `Deferred tools (${added})`,
          text: textOr(joinText(attachment.addedLines)),
          role: "system",
        },
      ];
    }
    case "hook_additional_context":
      return [
        {
          id,
          kind: "hook-output",
          origin: "hook",
          title:
            stringField(attachment, "hookName") ?? stringField(attachment, "hookEvent") ?? "Hook",
          text: textOr(joinText(attachment.content)),
          role: "system",
        },
      ];
    case "session_context": {
      const context = attachment.context;
      const text = isRecord(context)
        ? Object.values(context)
            .map((value) => (typeof value === "string" ? value : prettyJson(value)))
            .join("\n\n")
        : joinText(context);
      return [
        {
          id,
          kind: "environment",
          origin: "harness",
          title: "Session context",
          text: textOr(text),
          role: "user",
        },
      ];
    }
    case "environment":
      return [
        {
          id,
          kind: "environment",
          origin: "harness",
          title: "Environment",
          text: textOr(prettyJson(attachment.snapshot ?? attachment.changes ?? {})),
          role: "system",
        },
      ];
    case "date":
      return [
        {
          id,
          kind: "environment",
          origin: "harness",
          title: "Date",
          text: textOr(stringField(attachment, "date") ?? ""),
          role: "system",
        },
      ];
    case "model":
      return [
        {
          id,
          kind: "environment",
          origin: "harness",
          title: "Model",
          text: textOr(stringField(attachment, "text") ?? ""),
          role: "system",
        },
      ];
    default:
      return [];
  }
}

const systemLayers = (
  blocks: Json,
  idPrefix: string,
  titlePrefix: string,
  requestIndex: number | undefined,
): Array<TraceLayer> =>
  (Array.isArray(blocks) ? blocks : [blocks]).flatMap((block, index) => {
    const blockText = typeof block === "string" ? block : (stringField(block, "text") ?? "");
    if (blockText.length === 0) return [];
    const title = `${titlePrefix} ${index + 1}`;
    const common = { role: "system" as const, requestIndex };
    const profile = INSTRUCTION_PROFILE_BLOCK.exec(blockText);
    const text =
      profile === null
        ? blockText
        : `${blockText.slice(0, profile.index)}${blockText.slice(profile.index + profile[0].length)}`.trimEnd();
    const profileLayers =
      profile === null
        ? []
        : [
            makeLayer({
              ...common,
              id: `${idPrefix}:${index}:profile`,
              kind: "profile",
              origin: "profile",
              title: `${title}: instruction profile${profile[1] === undefined ? "" : ` ${profile[1]}`}`,
              text: profile[0],
            }),
          ];
    const split = firstT3Tag(text);
    const harnessPart = split < 0 ? text : text.slice(0, split).trimEnd();
    return [
      ...(harnessPart.length > 0
        ? [
            makeLayer({
              ...common,
              id: `${idPrefix}:${index}`,
              kind: "system-prompt",
              origin: "harness",
              title,
              text: harnessPart,
            }),
          ]
        : []),
      ...(split < 0
        ? []
        : [
            makeLayer({
              ...common,
              id: `${idPrefix}:${index}:t3`,
              kind: "host-instructions",
              origin: "t3",
              title: `${title}: T3 Code`,
              text: text.slice(split),
            }),
          ]),
      ...profileLayers,
    ];
  });

/**
 * Reads a Claude Code transcript in two streamed passes. The second pass is needed only when
 * some request messages have no blob record and must be rebuilt from user and assistant lines.
 */
export function makeClaudeTranscriptReader() {
  const blobs = new Map<string, Message>();
  const shapes = new Map<string, Shape>();
  const requests: Array<ApiRequestRecord> = [];
  const pending: Array<PendingLayer> = [];
  let promptSnapshot: { readonly systemPrompt: Json; readonly at?: string | undefined } | undefined;
  let sidechain = false;
  let lineCount = 0;

  const hash = makeCanonicalJson();
  const resolved = new Map<string, Message>();
  let needed: Set<string> | undefined;

  const acceptFirst = (line: string) => {
    lineCount++;
    const record = parseJsonLine(line);
    if (!isRecord(record)) return;
    const at = stringField(record, "timestamp");
    if (record.isSidechain === true) sidechain = true;
    switch (record.type) {
      case "api-request-blob":
        if (typeof record.hash === "string" && isRecord(record.message)) {
          blobs.set(record.hash, record.message);
        }
        return;
      case "api-request-shape":
        if (typeof record.shapeHash === "string" && isRecord(record.shape)) {
          shapes.set(record.shapeHash, { system: record.shape.system, tools: record.shape.tools });
        }
        return;
      case "api-request":
        if (typeof record.id !== "string" || record.isSidechain === true) return;
        requests.push({
          id: record.id,
          timestamp: at,
          base: stringField(record, "base"),
          keep: typeof record.keep === "number" ? record.keep : undefined,
          tail: Array.isArray(record.tail)
            ? record.tail.filter((item): item is string => typeof item === "string")
            : [],
          shapeHash: stringField(record, "shapeHash"),
          params: isRecord(record.params) ? record.params : {},
          cacheControl: Array.isArray(record.cacheControl)
            ? record.cacheControl.flatMap((entry) =>
                isRecord(entry) && Array.isArray(entry.path)
                  ? [{ path: entry.path as Array<string | number>, value: entry.value }]
                  : [],
              )
            : [],
          requestDigest: stringField(record, "requestDigest"),
        });
        return;
      case "attachment": {
        if (!isRecord(record.attachment) || record.isSidechain === true) return;
        if (record.attachment.type === "prompt_snapshot") {
          promptSnapshot ??= { systemPrompt: record.attachment.systemPrompt, at };
          return;
        }
        const id = `attachment:${stringField(record, "uuid") ?? lineCount}`;
        for (const layer of attachmentLayers(record.attachment, id)) {
          if (layer.text.length > 0)
            pending.push({ ...layer, requestsBefore: requests.length, at });
        }
        return;
      }
      case "user": {
        if (record.isSidechain === true || record.isMeta === true || !isRecord(record.message)) {
          return;
        }
        const content = record.message.content;
        if (isToolResultContent(content)) return;
        const text = textOfBlocks(content);
        if (text.length === 0) return;
        pending.push({
          id: `user:${stringField(record, "uuid") ?? lineCount}`,
          kind: "user-prompt",
          origin: "user",
          title: "User message",
          text,
          role: "user",
          requestsBefore: requests.length,
          at,
        });
        return;
      }
    }
  };

  /** Resolves blob hashes; returns whether a second pass over user and assistant lines is needed. */
  const prepareSecondPass = () => {
    for (const [blobHash, message] of blobs) {
      if (hash(message) === blobHash) {
        resolved.set(blobHash, message);
        continue;
      }
      // A blob may be stored with string content while the request used one text block.
      const normalized = { ...message, content: asContentArray(message.content) };
      resolved.set(
        blobHash,
        typeof message.content === "string" && hash(normalized) === blobHash ? normalized : message,
      );
    }
    needed = new Set(
      requests.flatMap((request) => request.tail.filter((tailHash) => !resolved.has(tailHash))),
    );
    return needed.size > 0;
  };

  const assistantGroups = new Map<string, Array<Record<string, Json>>>();
  let userRun: Array<Record<string, Json>> = [];
  const offer = (message: Message) => {
    if (needed === undefined || needed.size === 0) return;
    const messageHash = hash(message);
    if (needed.has(messageHash) && !resolved.has(messageHash)) {
      resolved.set(messageHash, message);
      needed.delete(messageHash);
    }
  };
  const contentOf = (record: Record<string, Json>) =>
    asContentArray((record.message as Message).content);
  const flushUserRun = () => {
    if (userRun.length > 1) {
      for (let start = 0; start < userRun.length; start++) {
        for (let end = start + 2; end <= userRun.length; end++) {
          offer({ role: "user", content: userRun.slice(start, end).flatMap(contentOf) });
        }
      }
    }
    userRun = [];
  };

  const acceptSecond = (line: string) => {
    if (needed === undefined || needed.size === 0) return;
    const record = parseJsonLine(line);
    if (!isRecord(record) || !isRecord(record.message)) return;
    if (record.type === "user") {
      const message = record.message;
      offer(message);
      offer({ role: "user", content: message.content });
      if (typeof message.content === "string") {
        offer({ role: "user", content: asContentArray(message.content) });
      }
      userRun.push(record);
      if (userRun.length > 12) userRun.shift();
    } else if (record.type === "assistant") {
      flushUserRun();
      const key =
        stringField(record, "requestRef") ??
        stringField(record.message, "id") ??
        stringField(record, "uuid") ??
        "";
      const group = assistantGroups.get(key) ?? [];
      group.push(record);
      assistantGroups.set(key, group);
    }
  };

  const finishSecondPass = () => {
    flushUserRun();
    const blockIndex = (record: Record<string, Json>) =>
      typeof record.apiBlockIndex === "number" ? record.apiBlockIndex : undefined;
    for (const unsorted of assistantGroups.values()) {
      const sorted = unsorted.toSorted((a, b) => (blockIndex(a) ?? 0) - (blockIndex(b) ?? 0));
      // The same block can be written twice; keep one per apiBlockIndex.
      const group = sorted.filter(
        (record, index) =>
          blockIndex(record) === undefined ||
          index === 0 ||
          blockIndex(sorted[index - 1]!) !== blockIndex(record),
      );
      const wire: Record<string, Json> = Object.assign(
        {},
        ...group.map((record) => (isRecord(record.wireToolInputs) ? record.wireToolInputs : {})),
      );
      const content = group.flatMap((record) => {
        const blocks = (record.message as Message).content;
        return Array.isArray(blocks) ? blocks : [];
      });
      offer({ role: "assistant", content });
      const wired = content.map((block) => {
        const id = stringField(block, "id");
        return isRecord(block) && block.type === "tool_use" && id !== undefined && id in wire
          ? { ...block, input: wire[id] }
          : block;
      });
      offer({ role: "assistant", content: wired });
      // An advisor call whose result never arrived is dropped from the next request.
      const answered = new Set(wired.map((block) => stringField(block, "tool_use_id")));
      const pruned = wired.filter(
        (block) =>
          !(
            isRecord(block) &&
            block.type === "server_tool_use" &&
            !answered.has(stringField(block, "id"))
          ),
      );
      if (pruned.length !== wired.length) offer({ role: "assistant", content: pruned });
    }
    assistantGroups.clear();
  };

  const finish = (): HarnessTrace => {
    if (needed === undefined) prepareSecondPass();
    const notes: Array<string> = [];
    if (sidechain) {
      notes.push("Subagent requests are not shown yet; this trace covers the main thread.");
    }
    const textLength = makeTextLength();
    const byId = new Map(requests.map((request) => [request.id, request]));
    const messagesById = new Map<string, Array<Json> | null>();
    const messagesOf = (request: ApiRequestRecord): Array<Json> | null => {
      const chain: Array<ApiRequestRecord> = [];
      let current: ApiRequestRecord | undefined = request;
      while (current !== undefined && !messagesById.has(current.id)) {
        chain.push(current);
        if (!current.base || !current.keep) break;
        const base = byId.get(current.base);
        if (base === undefined) {
          messagesById.set(current.id, null);
          break;
        }
        if (chain.includes(base)) break;
        current = base;
      }
      for (const link of chain.toReversed()) {
        if (messagesById.has(link.id)) continue;
        let head: Array<Json> = [];
        if (link.base && link.keep) {
          const baseMessages = messagesById.get(link.base);
          if (!baseMessages) {
            messagesById.set(link.id, null);
            continue;
          }
          head = baseMessages.slice(0, link.keep);
        } else if (link.keep) {
          messagesById.set(link.id, null);
          continue;
        }
        const tail = link.tail.map((tailHash) => resolved.get(tailHash));
        messagesById.set(
          link.id,
          tail.every((message) => message !== undefined) ? [...head, ...tail] : null,
        );
      }
      return messagesById.get(request.id) ?? null;
    };
    const bodyOf = (request: ApiRequestRecord) => {
      const messages = messagesOf(request);
      const shape = request.shapeHash === undefined ? undefined : shapes.get(request.shapeHash);
      if (messages === null || shape === undefined) return undefined;
      const body: Record<string, Json> = {
        ...request.params,
        system: shape.system,
        tools: shape.tools,
        messages,
      };
      let applied = true;
      for (const entry of request.cacheControl) {
        if (!setCacheControl(body, entry.path, entry.value)) applied = false;
      }
      return { body, applied };
    };

    const traceRequests: Array<TraceRequest> = requests.map((request, index) => {
      const shape = request.shapeHash === undefined ? undefined : shapes.get(request.shapeHash);
      const rebuilt = bodyOf(request);
      const messages = rebuilt === undefined ? [] : (rebuilt.body.messages as Array<Json>);
      const verified =
        rebuilt !== undefined &&
        rebuilt.applied &&
        request.requestDigest !== undefined &&
        hash(rebuilt.body) === request.requestDigest;
      const systemChars = textLength(shape?.system);
      const toolChars = textLength(shape?.tools);
      const messageChars = textLength(messages);
      const model = request.params.model;
      return {
        index,
        ...(request.timestamp === undefined ? {} : { at: request.timestamp }),
        ...(typeof model === "string" ? { model } : {}),
        systemChars,
        toolCount: Array.isArray(shape?.tools) ? shape.tools.length : 0,
        toolChars,
        messageCount: messages.length,
        messageChars,
        totalChars: systemChars + toolChars + messageChars,
        verified,
        partText: (part) => {
          const body = bodyOf(request)?.body;
          if (part === "system") return textOfBlocks(body?.system ?? shape?.system);
          return prettyJson(
            part === "tools" ? (body?.tools ?? shape?.tools ?? []) : (body?.messages ?? []),
          );
        },
      };
    });
    const unrebuilt = traceRequests.filter((request) => !request.verified).length;
    if (unrebuilt > 0) {
      notes.push(
        `${unrebuilt} of ${traceRequests.length} requests could not be checked against their digest.`,
      );
    }

    const layers: Array<TraceLayer> = [];
    const firstShape = requests
      .map((request) =>
        request.shapeHash === undefined ? undefined : shapes.get(request.shapeHash),
      )
      .find((shape) => shape !== undefined);
    if (firstShape !== undefined) {
      layers.push(...systemLayers(firstShape.system, "system", "System block", 0));
      const tools = Array.isArray(firstShape.tools) ? firstShape.tools : [];
      layers.push(
        makeLayer({
          id: "tools",
          kind: "tools",
          origin: "harness",
          title: `Tools (${tools.length})`,
          text: prettyJson(tools),
          requestIndex: 0,
        }),
      );
    } else if (promptSnapshot !== undefined) {
      layers.push(
        ...systemLayers(
          promptSnapshot.systemPrompt,
          "snapshot",
          "System prompt part",
          undefined,
        ).map((layer) =>
          promptSnapshot?.at === undefined ? layer : { ...layer, at: promptSnapshot.at },
        ),
      );
    }
    for (const layer of pending) {
      layers.push(
        makeLayer({
          ...layer,
          requestIndex: layer.requestsBefore < requests.length ? layer.requestsBefore : undefined,
        }),
      );
    }
    if (requests.length === 0) {
      notes.push(
        "This Claude Code version does not store API requests; showing loaded files only.",
      );
    }
    return {
      fidelity: requests.length > 0 ? "exact" : "harness-record",
      layers,
      requests: traceRequests,
      notes,
    };
  };

  return { acceptFirst, prepareSecondPass, acceptSecond, finishSecondPass, finish };
}

/** Reads a whole transcript held in memory, for tests and small files. */
export function readClaudeTranscriptLines(lines: ReadonlyArray<string>): HarnessTrace {
  const reader = makeClaudeTranscriptReader();
  for (const line of lines) reader.acceptFirst(line);
  if (reader.prepareSecondPass()) {
    for (const line of lines) reader.acceptSecond(line);
    reader.finishSecondPass();
  }
  return reader.finish();
}
