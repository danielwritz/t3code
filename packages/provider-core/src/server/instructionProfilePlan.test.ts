import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  type InstructionProfile,
  type InstructionProfileItem,
} from "@t3tools/contracts";

import {
  INSTRUCTION_PROFILE_CODEX_CONTEXT_KEY,
  instructionProfileBlock,
  instructionProfileSupportTable,
  planInstructionProfile,
} from "./instructionProfilePlan.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const antigravity = ProviderDriverKind.make("antigravity");
const cursor = ProviderDriverKind.make("cursor");

const profile = (
  items: ReadonlyArray<InstructionProfileItem>,
  globalInstructions = "",
): InstructionProfile => ({
  id: "p1",
  name: "Lean",
  description: "",
  globalInstructions,
  items,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const off = (kind: InstructionProfileItem["kind"], name: string): InstructionProfileItem => ({
  kind,
  name,
  enabled: false,
});
const on = (kind: InstructionProfileItem["kind"], name: string): InstructionProfileItem => ({
  kind,
  name,
  enabled: true,
});

const results = (plan: ReturnType<typeof planInstructionProfile>) =>
  plan.effects.map((effect) => [effect.kind, effect.name ?? null, effect.result]);

describe("planInstructionProfile", () => {
  it("wraps global instructions in a named block and escapes the name", () => {
    assert.strictEqual(
      instructionProfileBlock('A "b" <c>', "Use tabs."),
      '<instruction_profile name="A &quot;b&quot; &lt;c&gt;">\nUse tabs.\n</instruction_profile>',
    );
  });

  it("leaves an empty profile with no effects and no launch fields", () => {
    const plan = planInstructionProfile(claude, profile([]), {});
    assert.deepStrictEqual(plan, { effects: [] });
  });

  describe("Claude", () => {
    it("appends the block, hides named skills, denies agents and MCP servers", () => {
      const plan = planInstructionProfile(
        claude,
        profile(
          [
            off("skill", "pdf"),
            off("agent", "reviewer"),
            off("mcpServer", "github"),
            on("skill", "x"),
          ],
          "Be brief.",
        ),
        {},
      );
      assert.deepStrictEqual(plan.claude, {
        appendSystemPrompt: '<instruction_profile name="Lean">\nBe brief.\n</instruction_profile>',
        settings: {
          skillOverrides: { pdf: "off" },
          permissionsDeny: ["Agent(reviewer)"],
          deniedMcpServers: [{ serverName: "github" }],
        },
      });
      assert.deepStrictEqual(results(plan), [
        ["global-instructions", null, "applied"],
        ["skill", "pdf", "applied"],
        ["agent", "reviewer", "applied"],
        ["mcpServer", "github", "applied"],
        ["skill", "x", "skipped"],
      ]);
      assert.strictEqual(plan.codex, undefined);
      assert.strictEqual(plan.acp, undefined);
    });

    it("turns all skills off with an allow list of the named ones left on", () => {
      const plan = planInstructionProfile(
        claude,
        profile([off("skill", "*"), on("skill", "docx"), off("skill", "pdf")]),
        {},
      );
      assert.deepStrictEqual(plan.claude, { skills: ["docx"] });
      assert.deepStrictEqual(results(plan), [
        ["skill", "*", "applied"],
        ["skill", "docx", "applied"],
        ["skill", "pdf", "skipped"],
      ]);
    });

    it("denies the Agent tool and loads only T3 MCP servers when all are off", () => {
      const plan = planInstructionProfile(
        claude,
        profile([
          off("agent", "*"),
          on("agent", "reviewer"),
          off("mcpServer", "*"),
          on("mcpServer", "github"),
          off("mcpServer", "t3-code"),
        ]),
        {},
      );
      assert.deepStrictEqual(plan.claude, {
        strictMcpConfig: true,
        settings: { permissionsDeny: ["Agent"] },
      });
      assert.deepStrictEqual(results(plan), [
        ["agent", "*", "applied"],
        ["agent", "reviewer", "not-supported"],
        ["mcpServer", "*", "applied"],
        ["mcpServer", "github", "not-supported"],
        ["mcpServer", "t3-code", "skipped"],
      ]);
    });
  });

  describe("Codex", () => {
    const configServers = { codexConfigMcpServers: ["github", "linear"] };

    it("adds the text as context and sets per-thread config keys", () => {
      const plan = planInstructionProfile(
        codex,
        profile(
          [
            off("skill", "pdf"),
            off("skill", "docx"),
            off("agent", "*"),
            off("mcpServer", "github"),
            off("mcpServer", "plugin-server"),
            off("agent", "reviewer"),
          ],
          "Be brief.",
        ),
        configServers,
      );
      assert.deepStrictEqual(plan.codex, {
        additionalContext: [{ key: INSTRUCTION_PROFILE_CODEX_CONTEXT_KEY, value: "Be brief." }],
        config: {
          "skills.config": [
            { name: "pdf", enabled: false },
            { name: "docx", enabled: false },
          ],
          "agents.enabled": false,
          "mcp_servers.github.enabled": false,
        },
      });
      const plugin = plan.effects.find((effect) => effect.name === "plugin-server");
      assert.strictEqual(plugin?.result, "not-supported");
      assert.strictEqual(
        plugin?.reason,
        "plugin server: Codex rejects this key and the session fails to open",
      );
      assert.strictEqual(
        plan.effects.find((effect) => effect.name === "reviewer")?.result,
        "skipped",
      );
      const single = planInstructionProfile(codex, profile([off("agent", "reviewer")]), {});
      assert.deepStrictEqual(results(single), [["agent", "reviewer", "not-supported"]]);
      assert.strictEqual(single.codex, undefined);
    });

    it("drops the skills list and disables only config.toml servers when all are off", () => {
      const plan = planInstructionProfile(
        codex,
        profile([
          off("skill", "*"),
          on("skill", "pdf"),
          off("mcpServer", "*"),
          on("mcpServer", "linear"),
        ]),
        configServers,
      );
      assert.deepStrictEqual(plan.codex, {
        config: {
          "skills.include_instructions": false,
          "mcp_servers.github.enabled": false,
        },
      });
      assert.deepStrictEqual(results(plan), [
        ["skill", "*", "applied"],
        ["skill", "pdf", "not-supported"],
        ["mcpServer", "*", "applied"],
        ["mcpServer", "linear", "skipped"],
      ]);
      // Codex reads thread config only at thread start or resume, never on a loaded thread.
      for (const effect of plan.effects.filter((entry) => entry.result === "applied")) {
        assert.match(effect.how, /starts or resumes this thread/);
      }
    });

    it("never emits a key for a name it cannot address", () => {
      const plan = planInstructionProfile(
        codex,
        profile([off("mcpServer", "*"), off("mcpServer", "a.b")]),
        { codexConfigMcpServers: ["a.b", "t3-code"] },
      );
      assert.strictEqual(plan.codex, undefined);
      assert.deepStrictEqual(results(plan), [
        ["mcpServer", "*", "skipped"],
        ["mcpServer", "a.b", "not-supported"],
      ]);
    });

    it("splits long text into numbered entries under the Codex size cap", () => {
      const text = Array.from(
        { length: 300 },
        (_, index) => `Line ${index} ${"x".repeat(30)}`,
      ).join("\n");
      const entries = planInstructionProfile(codex, profile([], text), {}).codex?.additionalContext;
      assert.isAbove(entries?.length ?? 0, 1);
      assert.deepStrictEqual(entries?.map((entry) => entry.key).slice(0, 2), [
        `${INSTRUCTION_PROFILE_CODEX_CONTEXT_KEY}_01`,
        `${INSTRUCTION_PROFILE_CODEX_CONTEXT_KEY}_02`,
      ]);
      for (const entry of entries ?? []) {
        assert.isAtMost(new TextEncoder().encode(entry.value).length, 4_000);
      }
      assert.strictEqual(entries?.map((entry) => entry.value).join("\n"), text);
    });
  });

  it("ACP drivers get the prompt block and no item switches", () => {
    const plan = planInstructionProfile(
      antigravity,
      profile([off("skill", "pdf"), off("mcpServer", "*")], "Be brief."),
      {},
    );
    assert.deepStrictEqual(plan.acp, {
      promptPrefix: '<instruction_profile name="Lean">\nBe brief.\n</instruction_profile>',
    });
    assert.deepStrictEqual(results(plan), [
      ["global-instructions", null, "applied"],
      ["skill", "pdf", "not-supported"],
      ["mcpServer", "*", "not-supported"],
    ]);
  });

  it("other drivers report every entry as not supported and change nothing", () => {
    const plan = planInstructionProfile(cursor, profile([off("agent", "x")], "Be brief."), {});
    assert.deepStrictEqual(results(plan), [
      ["global-instructions", null, "not-supported"],
      ["agent", "x", "not-supported"],
    ]);
    assert.deepStrictEqual(Object.keys(plan), ["effects"]);
  });

  it("support table has a row per supported driver and a catch-all row", () => {
    const table = instructionProfileSupportTable();
    assert.deepStrictEqual(
      table.map((row) => row.driver),
      ["claudeAgent", "codex", "antigravity", "fx", "grok", "kiro", "acpRegistry", "*"],
    );
    for (const row of table) assert.strictEqual(row.kinds.length, 4);
  });
});
