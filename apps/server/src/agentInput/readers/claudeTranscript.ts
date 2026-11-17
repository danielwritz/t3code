// @effect-diagnostics nodeBuiltinImport:off -- request digests hash many messages synchronously.
import * as NodeCrypto from "node:crypto";

import type { AgentInputLayerKind, AgentInputOrigin } from "@t3tools/contracts";

import {
  isRecord,
  makeLayer,
  makePrettyJsonLength,
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

/** The dialog lists this many of the latest requests; older ones are only counted. */
export const CLAUDE_LISTED_REQUESTS = 50;
/** Open assistant messages kept while matching; a block written later than this is matched alone. */
const OPEN_ASSISTANT_GROUPS = 16;

interface IndexedRequest extends ApiRequestRecord {
  readonly systemChars: number;
  readonly toolChars: number;
  readonly toolCount: number;
}

/** What a later pass needs to rebuild any one request. */
export interface ClaudeRequestIndex {
  readonly requests: ReadonlyArray<IndexedRequest>;
  readonly blobHashes: ReadonlySet<string>;
}

export interface RebuiltClaudeRequest {
  readonly system: string;
  readonly tools: string;
  readonly messages: string;
  readonly messageCount: number;
  readonly verification: "verified" | "unverified";
}

export interface ClaudeTranscriptRead {
  readonly trace: HarnessTrace;
  readonly index: ClaudeRequestIndex;
  /** The request the layers describe, rebuilt by a second pass. */
  readonly latest: number | undefined;
}

const messageCountOf = (request: ApiRequestRecord, byId: ReadonlyMap<string, ApiRequestRecord>) => {
  if (!request.keep) return request.tail.length;
  return request.base !== undefined && byId.has(request.base)
    ? request.keep + request.tail.length
    : 0;
};

/**
 * First streamed pass: the layers, each request's record and cheap sizes, and which messages
 * have blobs. Request bodies are not rebuilt here; shapes are dropped once sized.
 */
export function makeClaudeIndexReader() {
  const shapes = new Map<string, Shape>();
  const shapeSizes = new Map<string, { systemChars: number; toolChars: number }>();
  const requests: Array<IndexedRequest> = [];
  const blobHashes = new Set<string>();
  const pending: Array<PendingLayer> = [];
  // Requests repeat their params and cache settings, and sessions repeat instruction files.
  const interned = new Map<string, Json>();
  const texts = new Map<string, string>();
  const prettyLength = makePrettyJsonLength();
  let promptSnapshot: { readonly systemPrompt: Json; readonly at?: string | undefined } | undefined;
  let sidechain = false;
  let lineCount = 0;

  const intern = <A extends Json>(value: A): A => {
    const key = JSON.stringify(value);
    const known = interned.get(key);
    if (known !== undefined) return known as A;
    interned.set(key, value);
    return value;
  };
  const internText = (text: string) => {
    const known = texts.get(text);
    if (known !== undefined) return known;
    texts.set(text, text);
    return text;
  };

  const sizesOf = (
    shapeHash: string | undefined,
    cacheControl: ApiRequestRecord["cacheControl"],
  ) => {
    const shape = shapeHash === undefined ? undefined : shapes.get(shapeHash);
    if (shape === undefined) return { systemChars: 0, toolChars: 0, toolCount: 0 };
    const toolCount = Array.isArray(shape.tools) ? shape.tools.length : 0;
    const toolPaths = cacheControl.filter((entry) => entry.path[0] === "tools");
    let sizes = shapeSizes.get(shapeHash!);
    if (sizes === undefined) {
      sizes = {
        systemChars: textOfBlocks(shape.system).length,
        toolChars: prettyLength(shape.tools ?? []),
      };
      shapeSizes.set(shapeHash!, sizes);
    }
    if (toolPaths.length === 0) return { ...sizes, toolCount };
    const root: Record<string, Json> = { tools: shape.tools };
    for (const entry of toolPaths) setCacheControl(root, entry.path, entry.value);
    return { systemChars: sizes.systemChars, toolChars: prettyLength(root.tools ?? []), toolCount };
  };

  const accept = (line: string) => {
    lineCount++;
    const record = parseJsonLine(line);
    if (!isRecord(record)) return;
    const at = stringField(record, "timestamp");
    if (record.isSidechain === true) sidechain = true;
    switch (record.type) {
      case "api-request-blob":
        if (typeof record.hash === "string") blobHashes.add(record.hash);
        return;
      case "api-request-shape":
        if (typeof record.shapeHash === "string" && isRecord(record.shape)) {
          shapes.set(record.shapeHash, { system: record.shape.system, tools: record.shape.tools });
        }
        return;
      case "api-request": {
        if (typeof record.id !== "string" || record.isSidechain === true) return;
        const shapeHash = stringField(record, "shapeHash");
        const cacheControl = Array.isArray(record.cacheControl)
          ? record.cacheControl.flatMap((entry) =>
              isRecord(entry) && Array.isArray(entry.path)
                ? [{ path: entry.path as Array<string | number>, value: intern(entry.value) }]
                : [],
            )
          : [];
        requests.push({
          id: record.id,
          timestamp: at,
          base: stringField(record, "base"),
          keep: typeof record.keep === "number" ? record.keep : undefined,
          tail: Array.isArray(record.tail)
            ? record.tail.filter((item): item is string => typeof item === "string")
            : [],
          shapeHash,
          params: intern(isRecord(record.params) ? record.params : {}),
          cacheControl,
          requestDigest: stringField(record, "requestDigest"),
          ...sizesOf(shapeHash, cacheControl),
        });
        return;
      }
      case "attachment": {
        if (!isRecord(record.attachment) || record.isSidechain === true) return;
        if (record.attachment.type === "prompt_snapshot") {
          promptSnapshot ??= { systemPrompt: record.attachment.systemPrompt, at };
          return;
        }
        const id = `attachment:${stringField(record, "uuid") ?? lineCount}`;
        for (const layer of attachmentLayers(record.attachment, id)) {
          if (layer.text.length > 0) {
            pending.push({
              ...layer,
              text: internText(layer.text),
              requestsBefore: requests.length,
              at,
            });
          }
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
          text: internText(text),
          role: "user",
          requestsBefore: requests.length,
          at,
        });
        return;
      }
    }
  };

  const finish = (): ClaudeTranscriptRead => {
    const notes: Array<string> = [];
    if (sidechain) {
      notes.push("Subagent requests are not shown yet; this trace covers the main thread.");
    }
    const byId = new Map(requests.map((request) => [request.id, request]));
    const firstListed = Math.max(0, requests.length - CLAUDE_LISTED_REQUESTS);
    if (firstListed > 0) notes.push(`${firstListed} earlier requests are not listed.`);
    const listed: Array<TraceRequest> = requests.slice(firstListed).map((request, offset) => {
      const model = request.params.model;
      return {
        index: firstListed + offset,
        ...(request.timestamp === undefined ? {} : { at: request.timestamp }),
        ...(typeof model === "string" ? { model } : {}),
        systemChars: request.systemChars,
        toolCount: request.toolCount,
        toolChars: request.toolChars,
        messageCount: messageCountOf(request, byId),
        verification: "not-checked",
      };
    });

    const layers: Array<TraceLayer> = [];
    // The system prompt can change mid-session (an instruction profile chosen later), so the
    // layers show what the latest request carried.
    const latestHash = requests.findLast(
      (request) => request.shapeHash !== undefined && shapes.has(request.shapeHash),
    )?.shapeHash;
    const latestShape = latestHash === undefined ? undefined : shapes.get(latestHash);
    const shapeIndex = requests.findIndex((request) => request.shapeHash === latestHash);
    if (latestShape !== undefined) {
      layers.push(...systemLayers(latestShape.system, "system", "System block", shapeIndex));
      const tools = Array.isArray(latestShape.tools) ? latestShape.tools : [];
      layers.push(
        makeLayer({
          id: "tools",
          kind: "tools",
          origin: "harness",
          title: `Tools (${tools.length})`,
          text: prettyJson(tools),
          requestIndex: shapeIndex,
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
    let retainedChars = blobHashes.size * 64 + listed.length * 200;
    for (const text of texts.keys()) retainedChars += text.length;
    for (const layer of layers) if (!texts.has(layer.text)) retainedChars += layer.text.length;
    for (const request of requests) retainedChars += 200 + request.tail.length * 64;
    shapes.clear();
    return {
      trace: {
        fidelity: requests.length > 0 ? "exact" : "harness-record",
        layers,
        requests: listed,
        notes,
        retainedChars,
      },
      index: { requests, blobHashes },
      latest: requests.length > 0 ? requests.length - 1 : undefined,
    };
  };

  return { accept, finish };
}

interface ChainLink {
  readonly link: ApiRequestRecord;
  /** How many of this link's messages the target request uses. */
  readonly count: number;
  readonly headLen: number;
}

/** messages(N) = messages(base)[0:keep] ++ tail, walked from the target to its root. */
function chainOf(
  byId: ReadonlyMap<string, ApiRequestRecord>,
  target: ApiRequestRecord,
): ReadonlyArray<ChainLink> | undefined {
  const chain: Array<ChainLink> = [];
  const seen = new Set<string>();
  let link = target;
  let need = Number.POSITIVE_INFINITY;
  for (;;) {
    if (seen.has(link.id)) return undefined;
    seen.add(link.id);
    if (link.keep && !link.base) return undefined;
    const headLen = link.base && link.keep ? link.keep : 0;
    const count = Math.min(need, headLen + link.tail.length);
    chain.push({ link, count, headLen });
    if (headLen === 0) return chain;
    const base = byId.get(link.base!);
    if (base === undefined) return undefined;
    need = Math.min(count, headLen);
    link = base;
  }
}

/**
 * Second streamed pass for one request: keeps only its shape and the messages it uses, matching
 * messages without a blob against the user and assistant lines, then checks the digest.
 */
export function makeClaudeRequestRebuilder(index: ClaudeRequestIndex, requestIndex: number) {
  const target = index.requests[requestIndex];
  const byId = new Map(index.requests.map((request) => [request.id, request]));
  const chain = target === undefined ? undefined : chainOf(byId, target);
  const needed = new Set(
    (chain ?? []).flatMap(({ link, count, headLen }) =>
      link.tail.slice(0, Math.max(0, count - headLen)),
    ),
  );
  const fromBlobs = new Set([...needed].filter((tailHash) => index.blobHashes.has(tailHash)));
  const unmatched = new Set([...needed].filter((tailHash) => !fromBlobs.has(tailHash)));
  const resolved = new Map<string, Message>();
  const hash = makeCanonicalJson();
  let shape: Shape | undefined;

  const offer = (message: Message) => {
    if (unmatched.size === 0) return;
    const messageHash = hash(message);
    if (unmatched.has(messageHash)) {
      resolved.set(messageHash, message);
      unmatched.delete(messageHash);
    }
  };
  const contentOf = (record: Record<string, Json>) =>
    asContentArray((record.message as Message).content);
  let userRun: Array<Record<string, Json>> = [];
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

  const blockIndex = (record: Record<string, Json>) =>
    typeof record.apiBlockIndex === "number" ? record.apiBlockIndex : undefined;
  const offerAssistant = (unsorted: ReadonlyArray<Record<string, Json>>) => {
    const sorted = unsorted.toSorted((a, b) => (blockIndex(a) ?? 0) - (blockIndex(b) ?? 0));
    // The same block can be written twice; keep one per apiBlockIndex.
    const group = sorted.filter(
      (record, position) =>
        blockIndex(record) === undefined ||
        position === 0 ||
        blockIndex(sorted[position - 1]!) !== blockIndex(record),
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
  };
  const assistantGroups = new Map<string, Array<Record<string, Json>>>();

  const accept = (line: string) => {
    if (target === undefined) return;
    if (unmatched.size === 0 && !line.includes('"api-request-')) return;
    const record = parseJsonLine(line);
    if (!isRecord(record)) return;
    switch (record.type) {
      case "api-request-shape":
        if (
          shape === undefined &&
          record.shapeHash === target.shapeHash &&
          isRecord(record.shape)
        ) {
          shape = { system: record.shape.system, tools: record.shape.tools };
        }
        return;
      case "api-request-blob": {
        const blobHash = record.hash;
        if (typeof blobHash !== "string" || !fromBlobs.has(blobHash)) return;
        if (resolved.has(blobHash) || !isRecord(record.message)) return;
        const message = record.message;
        // A blob may be stored with string content while the request used one text block.
        const normalized = { ...message, content: asContentArray(message.content) };
        resolved.set(
          blobHash,
          typeof message.content === "string" &&
            hash(message) !== blobHash &&
            hash(normalized) === blobHash
            ? normalized
            : message,
        );
        return;
      }
      case "user": {
        if (unmatched.size === 0 || !isRecord(record.message)) return;
        const message = record.message;
        offer(message);
        offer({ role: "user", content: message.content });
        if (typeof message.content === "string") {
          offer({ role: "user", content: asContentArray(message.content) });
        }
        userRun.push(record);
        if (userRun.length > 12) userRun.shift();
        return;
      }
      case "assistant": {
        if (unmatched.size === 0 || !isRecord(record.message)) return;
        flushUserRun();
        const key =
          stringField(record, "requestRef") ??
          stringField(record.message, "id") ??
          stringField(record, "uuid") ??
          "";
        const group = assistantGroups.get(key) ?? [];
        group.push(record);
        assistantGroups.delete(key);
        assistantGroups.set(key, group);
        for (const [oldest, records] of assistantGroups) {
          if (assistantGroups.size <= OPEN_ASSISTANT_GROUPS) break;
          assistantGroups.delete(oldest);
          offerAssistant(records);
        }
        return;
      }
    }
  };

  const finish = (): RebuiltClaudeRequest | undefined => {
    if (target === undefined) return undefined;
    flushUserRun();
    for (const records of assistantGroups.values()) offerAssistant(records);
    assistantGroups.clear();
    let messages: Array<Json> | undefined = chain === undefined ? undefined : [];
    for (const { link, count, headLen } of (chain ?? []).toReversed()) {
      const tail = link.tail
        .slice(0, Math.max(0, count - headLen))
        .map((tailHash) => resolved.get(tailHash));
      if (messages === undefined || tail.some((message) => message === undefined)) {
        messages = undefined;
        break;
      }
      messages = [...messages.slice(0, Math.min(count, headLen)), ...tail];
    }
    const body: Record<string, Json> | undefined =
      messages === undefined || shape === undefined
        ? undefined
        : { ...target.params, system: shape.system, tools: shape.tools, messages };
    let applied = body !== undefined;
    if (body !== undefined) {
      for (const entry of target.cacheControl) {
        if (!setCacheControl(body, entry.path, entry.value)) applied = false;
      }
    }
    const verified =
      body !== undefined &&
      applied &&
      target.requestDigest !== undefined &&
      hash(body) === target.requestDigest;
    const rebuiltMessages = (body?.messages as Array<Json> | undefined) ?? [];
    return {
      system: textOfBlocks(body?.system ?? shape?.system),
      tools: prettyJson(body?.tools ?? shape?.tools ?? []),
      messages: prettyJson(rebuiltMessages),
      messageCount: rebuiltMessages.length,
      verification: verified ? "verified" : "unverified",
    };
  };

  return { accept, finish };
}

/** Puts a rebuilt request's sizes and check into the listed request, when it is listed. */
export function withRebuiltRequest(
  trace: HarnessTrace,
  requestIndex: number,
  rebuilt: RebuiltClaudeRequest,
): HarnessTrace {
  return {
    ...trace,
    requests: trace.requests.map((request) =>
      request.index !== requestIndex
        ? request
        : {
            ...request,
            systemChars: rebuilt.system.length,
            toolChars: rebuilt.tools.length,
            messageCount: rebuilt.messageCount,
            messageChars: rebuilt.messages.length,
            totalChars: rebuilt.system.length + rebuilt.tools.length + rebuilt.messages.length,
            verification: rebuilt.verification,
          },
    ),
    notes:
      rebuilt.verification === "verified" || requestIndex !== trace.requests.at(-1)?.index
        ? trace.notes
        : [...trace.notes, "The latest request did not match the digest Claude Code stored."],
  };
}

/** Rebuilds one request from a transcript held in memory, for tests. */
export function rebuildClaudeRequestLines(
  lines: ReadonlyArray<string>,
  index: ClaudeRequestIndex,
  requestIndex: number,
): RebuiltClaudeRequest | undefined {
  const rebuilder = makeClaudeRequestRebuilder(index, requestIndex);
  for (const line of lines) rebuilder.accept(line);
  return rebuilder.finish();
}

/** Reads a whole transcript held in memory the way the server streams it, for tests. */
export function readClaudeTranscriptLines(lines: ReadonlyArray<string>): ClaudeTranscriptRead {
  const reader = makeClaudeIndexReader();
  for (const line of lines) reader.accept(line);
  const read = reader.finish();
  if (read.latest === undefined) return read;
  const rebuilt = rebuildClaudeRequestLines(lines, read.index, read.latest);
  return rebuilt === undefined
    ? read
    : { ...read, trace: withRebuiltRequest(read.trace, read.latest, rebuilt) };
}
