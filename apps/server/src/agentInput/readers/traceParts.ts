import type {
  AgentInputFidelity,
  AgentInputLayer,
  AgentInputLayerKind,
  AgentInputOrigin,
  AgentInputRequest,
  AgentInputRequestPart,
} from "@t3tools/contracts";

/** A layer plus its full text, which stays on the server until a client asks for it. */
export interface TraceLayer extends AgentInputLayer {
  readonly text: string;
}

export interface TraceRequest extends AgentInputRequest {
  /** Absent when the part must be rebuilt from the file first. */
  readonly partText?: (part: AgentInputRequestPart) => string;
}

export interface HarnessTrace {
  readonly fidelity: AgentInputFidelity;
  readonly layers: ReadonlyArray<TraceLayer>;
  readonly requests: ReadonlyArray<TraceRequest>;
  readonly notes: ReadonlyArray<string>;
  /** Characters the trace keeps alive, when the reader knows; it sizes the server cache. */
  readonly retainedChars?: number;
}

const PREVIEW_CHARS = 200;

const previewOf = (text: string) => text.replaceAll(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);

export function makeLayer(input: {
  readonly id: string;
  readonly kind: AgentInputLayerKind;
  readonly origin: AgentInputOrigin;
  readonly title: string;
  readonly text: string;
  readonly path?: string | undefined;
  readonly role?: AgentInputLayer["role"];
  readonly requestIndex?: number | undefined;
  readonly at?: string | undefined;
}): TraceLayer {
  return {
    id: input.id,
    kind: input.kind,
    origin: input.origin,
    title: input.title,
    text: input.text,
    chars: input.text.length,
    preview: previewOf(input.text),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.requestIndex === undefined ? {} : { requestIndex: input.requestIndex }),
    ...(input.at === undefined ? {} : { at: input.at }),
  };
}

/** T3 Code's own MCP servers; Codex writes their names with underscores. */
export const isT3McpServer = (server: string) => /^t3[-_]code(?:[-_]direct)?$/.test(server);

/** The MCP server in a Claude tool name (`mcp__<server>__<tool>`); undefined for built-in tools. */
export const mcpServerOfToolName = (name: string) => /^mcp__(.+?)__/.exec(name)?.[1];

interface ToolOwnerGroup<T> {
  /** Undefined for the agent's built-in tools. */
  readonly server: string | undefined;
  readonly origin: AgentInputOrigin;
  /** "Built-in tools", "T3 Code tools" or "<server> tools". */
  readonly label: string;
  readonly idSuffix: string;
  readonly items: ReadonlyArray<T>;
}

/** Built-in tools first, then one group per MCP server in first-seen order. */
export function groupToolsByOwner<T>(
  items: ReadonlyArray<T>,
  serverOf: (item: T) => string | undefined,
): ReadonlyArray<ToolOwnerGroup<T>> {
  const groups = new Map<string | undefined, Array<T>>([[undefined, []]]);
  for (const item of items) {
    const server = serverOf(item);
    const members = groups.get(server);
    if (members === undefined) groups.set(server, [item]);
    else members.push(item);
  }
  return [...groups]
    .filter(([, members]) => members.length > 0)
    .map(([server, members]) => ({
      server,
      origin: server === undefined ? "harness" : isT3McpServer(server) ? "t3" : "mcp-server",
      label:
        server === undefined
          ? "Built-in tools"
          : isT3McpServer(server)
            ? "T3 Code tools"
            : `${server} tools`,
      idSuffix: server === undefined ? "" : `:mcp:${server}`,
      items: members,
    }));
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const stringField = (value: unknown, key: string) => {
  const field = isRecord(value) ? value[key] : undefined;
  return typeof field === "string" ? field : undefined;
};

export const parseJsonLine = (line: string): unknown => {
  if (line.trim().length === 0) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    // A transcript being written can end with half a line.
    return undefined;
  }
};

export const prettyJson = (value: unknown) => JSON.stringify(value, null, 2);

/**
 * `prettyJson(value).length` without building the text. Requests share most messages, so each
 * object's length is cached per depth instead of re-serializing the history for every request.
 */
export function makePrettyJsonLength() {
  const cache = new WeakMap<object, Map<number, number>>();
  const lengthAt = (value: unknown, depth: number): number | undefined => {
    if (value === undefined || typeof value === "function" || typeof value === "symbol") {
      return undefined;
    }
    if (value === null || typeof value !== "object") return JSON.stringify(value).length;
    const cached = cache.get(value)?.get(depth);
    if (cached !== undefined) return cached;
    const indent = 2 * (depth + 1);
    const entries: Array<number> = [];
    if (Array.isArray(value)) {
      for (const item of value) entries.push(indent + (lengthAt(item, depth + 1) ?? 4));
    } else {
      for (const [key, item] of Object.entries(value)) {
        const itemLength = lengthAt(item, depth + 1);
        if (itemLength === undefined) continue;
        entries.push(indent + JSON.stringify(key).length + 2 + itemLength);
      }
    }
    // Brackets, the newline after the opening one, ",\n" between entries, "\n" and indent before the close.
    const total =
      entries.length === 0
        ? 2
        : entries.reduce((sum, entry) => sum + entry, 0) + 2 * entries.length + 2 + 2 * depth;
    const byDepth = cache.get(value) ?? new Map<number, number>();
    byDepth.set(depth, total);
    cache.set(value, byDepth);
    return total;
  };
  return (value: unknown) => lengthAt(value, 0) ?? 0;
}
