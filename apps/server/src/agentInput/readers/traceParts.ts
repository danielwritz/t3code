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
  readonly partText: (part: AgentInputRequestPart) => string;
}

export interface HarnessTrace {
  readonly fidelity: AgentInputFidelity;
  readonly layers: ReadonlyArray<TraceLayer>;
  readonly requests: ReadonlyArray<TraceRequest>;
  readonly notes: ReadonlyArray<string>;
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
