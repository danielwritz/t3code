// @effect-diagnostics nodeBuiltinImport:off -- fixtures compute the harness's sha256 digests.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";

import { readClaudeTranscriptLines } from "./claudeTranscript.ts";

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
  { type: "text", text: "Harness rules.\n\n<runtime_info>Running in T3 Code.</runtime_info>" },
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
  const trace = readClaudeTranscriptLines([...lines, '{"type":"user","mess']);

  it("rebuilds each request and checks it against its digest", () => {
    expect(trace.fidelity).toBe("exact");
    expect(trace.requests.map((request) => [request.messageCount, request.verified])).toEqual([
      [1, true],
      [4, false],
    ]);
    expect(trace.requests[1]!.partText("messages")).toContain("second question");
    expect(trace.requests[0]!.partText("system")).toContain("You are a test harness.");
    expect(trace.notes).toContain("1 of 2 requests could not be checked against their digest.");
  });

  it("splits the agent's input into labelled layers", () => {
    expect(
      trace.layers.map((layer) => [layer.kind, layer.origin, layer.title, layer.requestIndex]),
    ).toEqual([
      ["system-prompt", "harness", "System block 1", 0],
      ["system-prompt", "harness", "System block 2", 0],
      ["host-instructions", "t3", "System block 2: T3 Code", 0],
      ["tools", "harness", "Tools (1)", 0],
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

  it("falls back to the attachments when no request was recorded", () => {
    const attachmentsOnly = readClaudeTranscriptLines(lines.slice(0, 4));
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
