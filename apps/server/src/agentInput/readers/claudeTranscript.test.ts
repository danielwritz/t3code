// @effect-diagnostics nodeBuiltinImport:off -- fixtures compute the harness's sha256 digests.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";

import {
  CLAUDE_LISTED_REQUESTS,
  readClaudeTranscriptLines,
  rebuildClaudeRequestLines,
} from "./claudeTranscript.ts";

// The harness hashes key-sorted JSON; this copy is independent of the reader's own.
const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
        )
      : value;
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(sortKeys(value)))
    .digest("hex");

const system = [
  { type: "text", text: "You are a test harness." },
  {
    type: "text",
    text: 'Harness rules.\n\n<runtime_info>Running in T3 Code.</runtime_info>\n\n<instruction_profile name="Lean">\nBe brief.\n</instruction_profile>',
  },
];
const tools = [{ name: "Read", description: "Reads a file.", input_schema: { type: "object" } }];
const shapeHash = digest({ system, tools });
const params = { model: "claude-test", max_tokens: 10 };

const firstUser = { role: "user", content: [{ type: "text", text: "first question" }] };
const reply = { role: "assistant", content: [{ type: "text", text: "first answer" }] };
const skills = { role: "system", content: [{ type: "text", text: "skill list" }] };
const secondUser = { role: "user", content: [{ type: "text", text: "second question" }] };

const firstBody = {
  ...params,
  system: [system[0], { ...system[1], cache_control: { type: "ephemeral" } }],
  tools,
  messages: [firstUser],
};

const lines = [
  { type: "user", uuid: "u1", message: { role: "user", content: "first question" } },
  {
    type: "attachment",
    uuid: "a1",
    attachment: {
      type: "instructions",
      files: [{ path: "/repo/CLAUDE.md", type: "Project", content: "Use tabs." }],
    },
  },
  {
    type: "attachment",
    uuid: "a2",
    attachment: {
      type: "hook_additional_context",
      hookName: "SessionStart:startup",
      content: ["The hook says hello."],
    },
  },
  {
    type: "attachment",
    uuid: "a3",
    attachment: {
      type: "mcp_instructions_delta",
      addedNames: ["docs-server"],
      addedBlocks: ["Search the docs first."],
      removedNames: [],
    },
  },
  { type: "api-request-shape", shapeHash, shape: { system, tools } },
  {
    type: "api-request",
    id: "r1",
    timestamp: "2026-01-01T00:00:00.000Z",
    keep: 0,
    tail: [digest(firstUser)],
    shapeHash,
    params,
    cacheControl: [{ path: ["system", 1], value: { type: "ephemeral" } }],
    requestDigest: digest(firstBody),
  },
  {
    type: "assistant",
    requestRef: "r1",
    apiBlockIndex: 0,
    message: { id: "m1", role: "assistant", content: reply.content },
  },
  { type: "user", uuid: "u2", message: { role: "user", content: "second question" } },
  { type: "api-request-blob", hash: digest(skills), message: skills },
  {
    type: "api-request",
    id: "r2",
    base: "r1",
    keep: 1,
    tail: [digest(reply), digest(skills), digest(secondUser)],
    shapeHash,
    params,
    cacheControl: [],
    requestDigest: "0".repeat(64),
  },
].map((record) => JSON.stringify(record));

describe("readClaudeTranscriptLines", () => {
  const read = readClaudeTranscriptLines([...lines, '{"type":"user","mess']);
  const { trace } = read;
  const rebuild = (index: number) =>
    rebuildClaudeRequestLines([...lines, '{"type":"user","mess'], read.index, index);

  it("checks only the latest request up front and the others when their text is read", () => {
    expect(trace.fidelity).toBe("exact");
    expect(trace.requests.map((request) => [request.messageCount, request.verification])).toEqual([
      [1, "not-checked"],
      [4, "unverified"],
    ]);
    expect(trace.requests[0]!.messageChars).toBeUndefined();
    const first = rebuild(0);
    expect(first?.verification).toBe("verified");
    expect(first?.system).toContain("You are a test harness.");
    expect(first?.messages).toContain("first question");
    const second = rebuild(1);
    expect(second?.verification).toBe("unverified");
    expect(second?.messages).toContain("second question");
    expect(second?.messages).toContain("first answer");
    expect(rebuild(2)).toBeUndefined();
  });

  it("sizes each request part as the text it returns", () => {
    for (const request of trace.requests) {
      const rebuilt = rebuild(request.index)!;
      expect([request.systemChars, request.toolChars, request.messageCount]).toEqual([
        rebuilt.system.length,
        rebuilt.tools.length,
        rebuilt.messageCount,
      ]);
    }
    const latest = trace.requests[1]!;
    const rebuilt = rebuild(1)!;
    expect(latest.messageChars).toBe(rebuilt.messages.length);
    expect(latest.totalChars).toBe(
      rebuilt.system.length + rebuilt.tools.length + rebuilt.messages.length,
    );
  });

  it("lists only the latest requests and counts the rest in a note", () => {
    const many = Array.from({ length: CLAUDE_LISTED_REQUESTS + 2 }, (_, index) =>
      JSON.stringify({
        type: "api-request",
        id: `many-${index}`,
        keep: 0,
        tail: [digest(firstUser)],
        shapeHash,
        params,
      }),
    );
    const listed = readClaudeTranscriptLines([...lines.slice(0, 5), ...many]);
    expect(listed.trace.requests).toHaveLength(CLAUDE_LISTED_REQUESTS);
    expect(listed.trace.requests[0]!.index).toBe(2);
    expect(listed.trace.notes).toContain("2 earlier requests are not listed.");
  });

  it("splits the agent's input into labelled layers", () => {
    expect(
      trace.layers.map((layer) => [layer.kind, layer.origin, layer.title, layer.requestIndex]),
    ).toEqual([
      ["system-prompt", "harness", "System block 1", 0],
      ["system-prompt", "harness", "System block 2", 0],
      ["host-instructions", "t3", "System block 2: T3 Code", 0],
      ["profile", "profile", "System block 2: instruction profile Lean", 0],
      ["tools", "harness", "Built-in tools (1)", 0],
      ["user-prompt", "user", "User message", 0],
      ["instruction-file", "user-file", "CLAUDE.md (Project)", 0],
      ["hook-output", "hook", "SessionStart:startup", 0],
      ["mcp-instructions", "mcp-server", "docs-server", 0],
      ["user-prompt", "user", "User message", 1],
    ]);
    expect(trace.layers.find((layer) => layer.kind === "instruction-file")?.path).toBe(
      "/repo/CLAUDE.md",
    );
    expect(trace.layers.find((layer) => layer.origin === "t3")?.text).toBe(
      "<runtime_info>Running in T3 Code.</runtime_info>",
    );
  });

  it("takes the system layers from the latest request's system prompt", () => {
    const later = [system[0], { type: "text", text: "Harness rules, version 2." }];
    const laterHash = digest({ system: later, tools });
    const changed = readClaudeTranscriptLines([
      ...lines.slice(0, 7),
      JSON.stringify({
        type: "api-request-shape",
        shapeHash: laterHash,
        shape: { system: later, tools },
      }),
      JSON.stringify({
        type: "api-request",
        id: "r2",
        keep: 0,
        tail: [],
        shapeHash: laterHash,
        params,
      }),
    ]).trace;
    expect(
      changed.layers
        .filter((layer) => layer.kind !== "user-prompt" && layer.requestIndex === 1)
        .map((layer) => [layer.kind, layer.title]),
    ).toEqual([
      ["system-prompt", "System block 1"],
      ["system-prompt", "System block 2"],
      ["tools", "Built-in tools (1)"],
    ]);
    expect(changed.layers.some((layer) => layer.kind === "profile")).toBe(false);
  });

  it("splits the tools by owner: built in, T3 Code and each MCP server", () => {
    const mixed = [
      ...tools,
      { name: "mcp__t3-code__send_to_user", description: "T3." },
      { name: "mcp__docs-server__search", description: "Docs." },
    ];
    const mixedHash = digest({ system, tools: mixed });
    const owned = readClaudeTranscriptLines([
      JSON.stringify({
        type: "attachment",
        uuid: "d1",
        attachment: {
          type: "deferred_tools_delta",
          addedNames: ["Cron", "mcp__t3-code__t3_thread_wait", "mcp__docs-server__fetch"],
          addedLines: ["Cron", "mcp__t3-code__t3_thread_wait", "mcp__docs-server__fetch"],
        },
      }),
      JSON.stringify({
        type: "attachment",
        uuid: "m1",
        attachment: {
          type: "mcp_instructions_delta",
          addedNames: ["t3-code", "docs-server"],
          addedBlocks: ["Use T3 tools.", "Search the docs first."],
        },
      }),
      JSON.stringify({
        type: "api-request-shape",
        shapeHash: mixedHash,
        shape: { system, tools: mixed },
      }),
      JSON.stringify({
        type: "api-request",
        id: "r1",
        keep: 0,
        tail: [],
        shapeHash: mixedHash,
        params,
      }),
    ]).trace;
    expect(
      owned.layers
        .filter((layer) => layer.kind === "tools" || layer.kind === "mcp-instructions")
        .map((layer) => [layer.origin, layer.title, layer.text.includes("mcp__t3-code__")]),
    ).toEqual([
      ["harness", "Built-in tools (1)", false],
      ["t3", "T3 Code tools (1)", true],
      ["mcp-server", "docs-server tools (1)", false],
      ["harness", "Deferred built-in tools (1)", false],
      ["t3", "Deferred T3 Code tools (1)", true],
      ["mcp-server", "Deferred docs-server tools (1)", false],
      ["t3", "T3 Code", false],
      ["mcp-server", "docs-server", false],
    ]);
  });

  it("drops deferred tools that a later delta removed", () => {
    const delta = (uuid: string, added: Array<string>, removed: Array<string>) =>
      JSON.stringify({
        type: "attachment",
        uuid,
        attachment: {
          type: "deferred_tools_delta",
          addedNames: added,
          addedLines: added,
          removedNames: removed,
        },
      });
    const later = readClaudeTranscriptLines([
      delta("d1", ["Cron", "mcp__t3-code__t3_thread_wait", "mcp__t3-code__send_to_user"], []),
      delta("d2", [], ["mcp__t3-code__t3_thread_wait", "mcp__t3-code__send_to_user"]),
      delta("d3", ["Monitor", "mcp__t3-code__list"], ["Cron"]),
      delta("d4", [], ["mcp__t3-code__list"]),
    ]).trace;
    expect(later.layers.map((layer) => [layer.origin, layer.title, layer.text])).toEqual([
      ["harness", "Deferred built-in tools (1)", "Monitor"],
    ]);
  });

  it("falls back to the attachments when no request was recorded", () => {
    const attachmentsOnly = readClaudeTranscriptLines(lines.slice(0, 4)).trace;
    expect(attachmentsOnly.fidelity).toBe("harness-record");
    expect(attachmentsOnly.requests).toEqual([]);
    expect(attachmentsOnly.layers.map((layer) => layer.kind)).toEqual([
      "user-prompt",
      "instruction-file",
      "hook-output",
      "mcp-instructions",
    ]);
  });
});
