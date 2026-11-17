import { assert, describe, it } from "@effect/vitest";

import { parseCodexConfigMcpServerNames } from "./codexConfigMcpServers.ts";

describe("parseCodexConfigMcpServerNames", () => {
  it("finds servers in tables, a parent table, and dotted keys, and nothing else", () => {
    const toml = [
      'model = "gpt-5"',
      'mcp_servers.inline.command = "npx"',
      "",
      "[mcp_servers.github]",
      'command = "gh-mcp"',
      "",
      "[mcp_servers.github.env]",
      'TOKEN = "x"',
      "",
      '[mcp_servers."quoted name"] # comment',
      'url = "https://example.com"',
      "",
      "[mcp_servers]",
      'linear = { url = "https://linear.app/mcp" }',
      "",
      "[features]",
      "mcp_servers = true",
      "",
      "[[profiles]]",
      'mcp_servers.fake = "no"',
    ].join("\n");
    assert.deepStrictEqual(parseCodexConfigMcpServerNames(toml), [
      "inline",
      "github",
      "quoted name",
      "linear",
    ]);
  });
});
