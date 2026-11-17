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

/** Characters of text a model reads: string leaves, without signatures, binary data or keys. */
export function makeTextLength() {
  const cache = new WeakMap<object, number>();
  const textLength = (value: unknown): number => {
    if (typeof value === "string") return value.length;
    if (value === null || typeof value !== "object") return 0;
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
    let total = 0;
    if (Array.isArray(value)) {
      for (const item of value) total += textLength(item);
    } else {
      for (const [key, item] of Object.entries(value)) {
        if (key === "signature" || key === "data" || key === "encrypted_content") continue;
        total += textLength(item);
      }
    }
    cache.set(value, total);
    return total;
  };
  return textLength;
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
