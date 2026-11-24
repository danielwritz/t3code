import { expect, it } from "@effect/vitest";
import { publicInventory, readMachineInventory } from "./inventory.ts";
import { hashTree, makeFakeMachine } from "./testFakeMachine.ts";

it("lists every provider's parts with references, marks machine policy read-only and hides secrets", async () => {
  const { root, paths } = await makeFakeMachine();
  const before = await hashTree(root);
  const inventory = await readMachineInventory(paths);
  const view = publicInventory(inventory);
  const ids = (provider: string) =>
    view.providers
      .find((entry) => entry.provider === provider)!
      .items.map(
        (item) =>
          `${item.id}${item.enabled ? "" : " (off)"}${item.source === "machine-policy" ? " (policy)" : ""}`,
      );
  expect(ids("claude")).toEqual([
    "claude:instructions:CLAUDE.md",
    "claude:skill:alpha",
    "claude:plugin:design@market (off)",
    "claude:plugin:review@market",
    "claude:hook:PreToolUse:0",
    "claude:hook:policy:policy.json:PreToolUse:0 (policy)",
    "claude:mcp:calendar",
    "claude:mcp:docs",
  ]);
  expect(ids("codex")).toEqual([
    "codex:instructions:AGENTS.md",
    "codex:skill:beta",
    "codex:skill:gamma",
    "codex:plugin:browser@bundled",
    "codex:plugin:slides@curated (off)",
    "codex:hook:PreToolUse:0",
    "codex:hook:notify",
    "codex:hook:policy:hooks.json:PreToolUse:0 (policy)",
    "codex:mcp:repl",
  ]);
  expect(ids("antigravity")).toEqual([
    "antigravity:instructions:GEMINI.md",
    "antigravity:skill:delta",
    "antigravity:plugin:swarm (off)",
    "antigravity:hook:guard:PreToolUse:0",
    "antigravity:mcp:calendar",
  ]);
  const claude = view.providers[0]!.items;
  expect(claude.find((item) => item.id === "claude:mcp:calendar")!.detail).toEqual({
    transport: "stdio",
    command: "node",
    args: ["calendar.mjs"],
    envKeys: ["TOKEN"],
  });
  expect(claude.find((item) => item.id === "claude:mcp:docs")!.detail.headerKeys).toEqual([
    "Authorization",
  ]);
  expect(claude.find((item) => item.id === "claude:hook:PreToolUse:0")!.detail).toEqual({
    event: "PreToolUse",
    matcher: "Bash",
    commands: ["node guard.mjs"],
  });
  expect(claude.find((item) => item.kind === "plugin" && item.enabled)!.detail).toEqual({
    path: "/plugins/review",
    version: "1.2.0",
  });
  expect(JSON.stringify(view)).not.toContain("s3cret");
  expect(JSON.stringify(view)).not.toContain("not-read");
  expect(await hashTree(root)).toEqual(before);
});
