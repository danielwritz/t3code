import { describe, expect, it } from "@effect/vitest";

import { collectProtobufStrings, readAntigravitySession } from "./antigravitySession.ts";

const varint = (value: number) => {
  const bytes: Array<number> = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
};
const field = (number: number, payload: Uint8Array) =>
  Uint8Array.from([...varint((number << 3) | 2), ...varint(payload.length), ...payload]);
const text = (value: string) => new TextEncoder().encode(value);
const join = (...parts: Array<Uint8Array>) => Uint8Array.from(parts.flatMap((part) => [...part]));

const systemPrompt = "<identity>\nA test agent.\n</identity>\n<mcp_servers>\ndocs\n</mcp_servers>";
const generation = join(
  Uint8Array.from([0x08, 0x96, 0x01]),
  field(
    1,
    join(field(1, text(systemPrompt)), field(2, field(3, text("<USER_REQUEST>hi</USER_REQUEST>")))),
  ),
  Uint8Array.from([0x15, 1, 2, 3, 4]),
);

describe("collectProtobufStrings", () => {
  it("walks nested messages and skips numeric fields", () => {
    expect(collectProtobufStrings(generation)).toEqual([
      systemPrompt,
      "<USER_REQUEST>hi</USER_REQUEST>",
    ]);
  });

  it("rejects bytes that are not a message", () => {
    expect(collectProtobufStrings(Uint8Array.from([0x0a, 0x09, 0x41]))).toBeUndefined();
  });
});

describe("readAntigravitySession", () => {
  const userInput = [
    "<USER_REQUEST>",
    "<t3_code_instructions>\nUse T3 tools.\n</t3_code_instructions>",
    "",
    '<instruction_profile name="Lean">\nBe brief.\n</instruction_profile>',
    "",
    "<user_request>\nFix the bug.\n</user_request>",
    "",
    "<runtime_info>Running in T3 Code.</runtime_info>",
    "",
    "<pull_request_linking>Link PRs.</pull_request_linking>",
    "</USER_REQUEST>",
    "<ADDITIONAL_METADATA>local time</ADDITIONAL_METADATA>",
  ].join("\n");
  const trace = readAntigravitySession({
    transcriptLines: [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: userInput }),
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "ok" }),
    ],
    mcpTools: [{ server: "t3-code", name: "list", json: '{"name":"list"}' }],
    lastGeneration: generation,
  });

  it("splits T3's wrapper from the user's words and finds the system prompt", () => {
    expect(trace.layers.map((layer) => [layer.kind, layer.origin, layer.title])).toEqual([
      ["system-prompt", "harness", "identity"],
      ["system-prompt", "harness", "mcp_servers"],
      ["tools", "mcp-server", "t3-code (1 tools)"],
      ["host-instructions", "t3", "T3 instructions"],
      ["profile", "profile", "Instruction profile"],
      ["user-prompt", "user", "User message"],
      ["host-instructions", "t3", "Runtime info"],
      ["host-instructions", "t3", "Pull request linking"],
      ["environment", "harness", "Additional metadata"],
    ]);
    expect(trace.layers.find((layer) => layer.kind === "user-prompt")?.text).toBe("Fix the bug.");
    expect(trace.notes).toEqual([
      "Antigravity keeps only its latest request, so earlier system prompts are not shown.",
    ]);
  });
});
