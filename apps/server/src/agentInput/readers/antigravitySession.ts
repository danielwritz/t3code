import type { AgentInputLayerKind, AgentInputOrigin } from "@t3tools/contracts";

import {
  isRecord,
  makeLayer,
  parseJsonLine,
  prettyJson,
  stringField,
  type HarnessTrace,
  type TraceLayer,
} from "./traceParts.ts";

const MAX_DEPTH = 12;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

function readVarint(bytes: Uint8Array, start: number): [bigint, number] | undefined {
  let value = 0n;
  let shift = 0n;
  for (let index = start; index < bytes.length; index++) {
    const byte = bytes[index]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, index + 1];
    shift += 7n;
    if (shift > 63n) return undefined;
  }
  return undefined;
}

/**
 * Collects the UTF-8 strings of a protobuf message without its schema, in wire order. A
 * length-delimited field that decodes as text is a string; otherwise it is walked as a nested
 * message. Undefined when the bytes are not a well-formed message.
 */
export function collectProtobufStrings(bytes: Uint8Array, depth = 0): Array<string> | undefined {
  const strings: Array<string> = [];
  let index = 0;
  while (index < bytes.length) {
    const tag = readVarint(bytes, index);
    if (tag === undefined) return undefined;
    index = tag[1];
    const wireType = Number(tag[0] & 7n);
    if (tag[0] >> 3n === 0n) return undefined;
    if (wireType === 0) {
      const value = readVarint(bytes, index);
      if (value === undefined) return undefined;
      index = value[1];
    } else if (wireType === 1) {
      index += 8;
    } else if (wireType === 5) {
      index += 4;
    } else if (wireType === 2) {
      const length = readVarint(bytes, index);
      if (length === undefined) return undefined;
      index = length[1];
      const end = index + Number(length[0]);
      if (end > bytes.length) return undefined;
      const field = bytes.subarray(index, end);
      index = end;
      let text: string | undefined;
      try {
        text = utf8.decode(field);
      } catch {
        text = undefined;
      }
      if (text !== undefined && text.length > 0 && !CONTROL_CHARACTERS.test(text)) {
        strings.push(text);
      } else if (depth < MAX_DEPTH) {
        strings.push(...(collectProtobufStrings(field, depth + 1) ?? []));
      }
    } else {
      return undefined;
    }
    if (index > bytes.length) return undefined;
  }
  return strings;
}

const USER_REQUEST = "<USER_REQUEST>";
const SECTION = /^<([a-z][a-z0-9_]*)>/gm;

/** Finds the system prompt in Antigravity's last stored request: the text before its first user request. */
function antigravitySystemPrompt(strings: ReadonlyArray<string>): string | undefined {
  let best: string | undefined;
  for (const text of strings) {
    const cut = text.indexOf(USER_REQUEST);
    const candidate = cut < 0 ? text : text.slice(0, cut);
    if (
      /^\s*<[a-z][a-z0-9_]*>/.test(candidate) &&
      (best === undefined || candidate.length > best.length)
    ) {
      best = candidate;
    }
    if (cut >= 0) break;
  }
  return best?.trim();
}

/** Splits text into its top-level `<section>…</section>` blocks; text between them is kept. */
function splitSections(text: string): Array<{ readonly title: string; readonly text: string }> {
  const sections: Array<{ title: string; text: string }> = [];
  let cursor = 0;
  const pushLoose = (end: number) => {
    const loose = text.slice(cursor, end).trim();
    if (loose.length > 0) sections.push({ title: "System prompt", text: loose });
  };
  for (const match of text.matchAll(SECTION)) {
    if (match.index < cursor) continue;
    const close = `</${match[1]}>`;
    const end = text.indexOf(close, match.index);
    if (end < 0) continue;
    pushLoose(match.index);
    sections.push({ title: match[1]!, text: text.slice(match.index, end + close.length) });
    cursor = end + close.length;
  }
  pushLoose(text.length);
  return sections;
}

const T3_INSTRUCTIONS = /^\s*(<t3_code_instructions>[\s\S]*?<\/t3_code_instructions>)/;
const PROFILE_BLOCK = /^\s*(<instruction_profile[\s>][\s\S]*?<\/instruction_profile>)/;
const TRAILING_T3_BLOCK = /(<(runtime_info|pull_request_linking)>[\s\S]*?<\/\2>)\s*$/;
const unwrap = (text: string, tag: string) => {
  const match = new RegExp(`^\\s*<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>\\s*$`).exec(text);
  return match?.[1] ?? text;
};

/** Splits one Antigravity user input into the user's words and the blocks T3 or the harness added. */
function splitAntigravityUserInput(content: string) {
  let rest = content;
  let metadata: string | undefined;
  const metadataMatch = /<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>\s*$/.exec(rest);
  if (metadataMatch !== null) {
    metadata = metadataMatch[0].trim();
    rest = rest.slice(0, metadataMatch.index);
  }
  rest = unwrap(rest.trim(), "USER_REQUEST");
  const parts: Array<{
    readonly part: "t3" | "profile" | "user" | "metadata";
    readonly title: string;
    readonly text: string;
  }> = [];
  const instructions = T3_INSTRUCTIONS.exec(rest);
  if (instructions !== null) {
    parts.push({ part: "t3", title: "T3 instructions", text: instructions[1]! });
    rest = rest.slice(instructions[0].length);
  }
  const profile = PROFILE_BLOCK.exec(rest);
  if (profile !== null) {
    parts.push({ part: "profile", title: "Instruction profile", text: profile[1]! });
    rest = rest.slice(profile[0].length);
  }
  const trailing: Array<{ part: "t3"; title: string; text: string }> = [];
  for (
    let match = TRAILING_T3_BLOCK.exec(rest);
    match !== null;
    match = TRAILING_T3_BLOCK.exec(rest)
  ) {
    trailing.unshift({
      part: "t3",
      title: match[2] === "runtime_info" ? "Runtime info" : "Pull request linking",
      text: match[1]!,
    });
    rest = rest.slice(0, match.index);
  }
  const userText = unwrap(rest.trim(), "user_request").trim();
  if (userText.length > 0) parts.push({ part: "user", title: "User message", text: userText });
  parts.push(...trailing);
  if (metadata !== undefined)
    parts.push({ part: "metadata", title: "Additional metadata", text: metadata });
  return parts;
}

type UserInputPart = ReturnType<typeof splitAntigravityUserInput>[number]["part"];
const PART_KIND = {
  t3: "host-instructions",
  profile: "profile",
  user: "user-prompt",
  metadata: "environment",
} as const satisfies Record<UserInputPart, AgentInputLayerKind>;
const PART_ORIGIN = {
  t3: "t3",
  profile: "profile",
  user: "user",
  metadata: "harness",
} as const satisfies Record<UserInputPart, AgentInputOrigin>;

export interface AntigravitySessionFiles {
  readonly transcriptLines: Iterable<string>;
  readonly mcpTools: ReadonlyArray<{
    readonly server: string;
    readonly name: string;
    readonly json: string;
  }>;
  /** The newest `gen_metadata.data` blob, when the conversation database could be read. */
  readonly lastGeneration: Uint8Array | undefined;
}

export function readAntigravitySession(files: AntigravitySessionFiles): HarnessTrace {
  const layers: Array<TraceLayer> = [];
  const notes = [
    "Antigravity keeps only its latest request, so earlier system prompts are not shown.",
  ];

  if (files.lastGeneration !== undefined) {
    const strings = collectProtobufStrings(files.lastGeneration);
    const systemPrompt = strings === undefined ? undefined : antigravitySystemPrompt(strings);
    if (systemPrompt === undefined) {
      notes.push("The system prompt could not be found in Antigravity's stored request.");
    } else {
      splitSections(systemPrompt).forEach((section, index) => {
        layers.push(
          makeLayer({
            id: `system:${index}`,
            kind: "system-prompt",
            origin: "harness",
            title: section.title,
            text: section.text,
            role: "system",
          }),
        );
      });
    }
  } else {
    notes.push(
      "Antigravity's conversation database could not be read; the system prompt is missing.",
    );
  }

  const servers = new Map<string, Array<unknown>>();
  for (const tool of files.mcpTools) {
    const parsed = parseJsonLine(tool.json) ?? { name: tool.name };
    servers.set(tool.server, [...(servers.get(tool.server) ?? []), parsed]);
  }
  for (const [server, tools] of servers) {
    layers.push(
      makeLayer({
        id: `mcp:${server}`,
        kind: "tools",
        origin: "mcp-server",
        title: `${server} (${tools.length} tools)`,
        text: prettyJson(tools),
      }),
    );
  }

  let lineCount = 0;
  for (const line of files.transcriptLines) {
    lineCount++;
    const step = parseJsonLine(line);
    if (!isRecord(step) || step.type !== "USER_INPUT") continue;
    const content = stringField(step, "content");
    if (content === undefined) continue;
    const at = stringField(step, "created_at");
    const stepId = typeof step.step_index === "number" ? step.step_index : lineCount;
    splitAntigravityUserInput(content).forEach((part, index) => {
      layers.push(
        makeLayer({
          id: `step:${stepId}:${index}`,
          kind: PART_KIND[part.part],
          origin: PART_ORIGIN[part.part],
          title: part.title,
          text: part.text,
          role: "user",
          at,
        }),
      );
    });
  }
  return { fidelity: "harness-record", layers, requests: [], notes };
}
