import { describe, expect, it } from "@effect/vitest";

import { readCodexRolloutLines } from "./codexRollout.ts";

const text = (value: string) => ({ type: "input_text", text: value });
const message = (role: string, ...parts: Array<string>) => ({
  type: "response_item",
  payload: { type: "message", role, content: parts.map(text) },
});

const lines = [
  {
    type: "session_meta",
    payload: { timestamp: "2026-01-01T00:00:00.000Z", base_instructions: { text: "Base rules." } },
  },
  {
    type: "response_item",
    payload: {
      type: "additional_tools",
      tools: [
        { type: "namespace", name: "functions", tools: [{ name: "exec" }, { name: "wait" }] },
      ],
    },
  },
  message("developer", "Base rules."),
  message(
    "developer",
    "<skills_instructions>skill one</skills_instructions>",
    "<permissions>ask first</permissions>",
  ),
  message(
    "user",
    "# AGENTS.md instructions for /repo\n\nUse tabs.",
    "<environment_context>cwd</environment_context>",
  ),
  { type: "world_state", payload: { state: { agents_md: { directory: "/repo" } } } },
  { type: "turn_context", payload: { model: "gpt-test" } },
  message(
    "developer",
    "<t3_code_runtime>Running in T3 Code.</t3_code_runtime>",
    "<t3_code_instruction_profile>Be brief.</t3_code_instruction_profile>",
  ),
  message("user", "Fix the bug."),
  { type: "token_usage_record", timestamp: "2026-01-01T00:00:01.000Z", payload: {} },
  message("assistant", "Done."),
  message("developer", "<t3_code_runtime>Running in T3 Code.</t3_code_runtime>"),
  message("user", "Thanks."),
  { type: "token_usage_record", payload: {} },
].map((record) => JSON.stringify(record));

describe("readCodexRolloutLines", () => {
  const trace = readCodexRolloutLines(lines);

  it("classifies the rollout's context by its leading tag", () => {
    expect(
      trace.layers.map((layer) => [layer.kind, layer.origin, layer.title, layer.requestIndex]),
    ).toEqual([
      ["system-prompt", "harness", "Base instructions", 0],
      ["tools", "harness", "Tools (2)", 0],
      ["skills", "harness", "Skills", 0],
      ["system-prompt", "harness", "Section: permissions", 0],
      ["instruction-file", "user-file", "AGENTS.md", 0],
      ["environment", "harness", "Environment", 0],
      ["host-instructions", "t3", "Section: t3_code_runtime", 0],
      ["profile", "profile", "Instruction profile", 0],
      ["user-prompt", "user", "User message", 0],
      ["user-prompt", "user", "User message", 1],
    ]);
    expect(trace.layers.find((layer) => layer.kind === "instruction-file")?.path).toBe("/repo");
  });

  it("sizes one request per token usage record from the items sent so far", () => {
    expect(trace.requests.map((request) => [request.messageCount, request.model])).toEqual([
      [2, "gpt-test"],
      [4, "gpt-test"],
    ]);
    expect(trace.requests[0]!.toolCount).toBe(2);
    expect(trace.requests[1]!.partText("messages")).toContain("Thanks.");
    expect(trace.fidelity).toBe("harness-record");
    for (const request of trace.requests) {
      expect([request.systemChars, request.toolChars, request.messageChars]).toEqual([
        request.partText("system").length,
        request.partText("tools").length,
        request.partText("messages").length,
      ]);
    }
  });
});
