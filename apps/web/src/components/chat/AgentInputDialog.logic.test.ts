import type { AgentInputLayer, AgentInputProfileUse } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentInputFidelitySentence,
  agentInputLayerWhen,
  agentInputProfileEffectRows,
  agentInputSizeSegments,
  agentInputTextTargetKey,
  formatAgentInputChars,
  formatAgentInputShare,
  groupAgentInputLayers,
} from "./AgentInputDialog.logic";

const layer = (
  id: string,
  kind: AgentInputLayer["kind"],
  chars: number,
  extra: Partial<AgentInputLayer> = {},
): AgentInputLayer => ({
  id,
  kind,
  origin: "harness",
  title: id,
  chars,
  preview: "",
  ...extra,
});

describe("groupAgentInputLayers", () => {
  it("groups by kind in a fixed kind order and keeps layer order inside a group", () => {
    const groups = groupAgentInputLayers([
      layer("prompt", "user-prompt", 10),
      layer("sys-a", "system-prompt", 100),
      layer("claude-md", "instruction-file", 40),
      layer("sys-b", "system-prompt", 50),
    ]);
    expect(groups.map((group) => [group.kind, group.chars, group.layers.map((l) => l.id)])).toEqual(
      [
        ["system-prompt", 150, ["sys-a", "sys-b"]],
        ["instruction-file", 40, ["claude-md"]],
        ["user-prompt", 10, ["prompt"]],
      ],
    );
    expect(groups[0]!.label).toBe("System prompt");
  });

  it("returns no groups for no layers", () => {
    expect(groupAgentInputLayers([])).toEqual([]);
  });
});

describe("agentInputSizeSegments", () => {
  it("gives each kind a share of the total characters, largest first", () => {
    const segments = agentInputSizeSegments([
      layer("tools", "tools", 300),
      layer("sys", "system-prompt", 600),
      layer("prompt", "user-prompt", 100),
    ]);
    expect(segments.map((segment) => [segment.kind, segment.chars, segment.share])).toEqual([
      ["system-prompt", 600, 0.6],
      ["tools", 300, 0.3],
      ["user-prompt", 100, 0.1],
    ]);
  });

  it("drops kinds with zero characters and returns nothing when the total is zero", () => {
    expect(agentInputSizeSegments([layer("empty", "memory", 0)])).toEqual([]);
    expect(
      agentInputSizeSegments([layer("empty", "memory", 0), layer("sys", "system-prompt", 5)]).map(
        (segment) => segment.kind,
      ),
    ).toEqual(["system-prompt"]);
  });
});

describe("agentInputFidelitySentence", () => {
  it.each([
    ["exact", "Exact: rebuilt from the agent's own request record and checked against its digest"],
    ["harness-record", "From the agent's own session record"],
    ["t3-recorded", "Only what T3 sent; this agent keeps no readable record"],
    ["none", "Nothing recorded for this thread yet"],
  ] as const)("%s", (fidelity, sentence) => {
    expect(agentInputFidelitySentence(fidelity)).toBe(sentence);
  });
});

describe("formatting", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1_000, "1.0k"],
    [12_345, "12.3k"],
    [999_949, "999.9k"],
    [999_999, "1.0M"],
    [2_500_000, "2.5M"],
  ])("formats %d characters as %s", (chars, text) => {
    expect(formatAgentInputChars(chars)).toBe(text);
  });

  it.each([
    [1, "100%"],
    [0.423, "42%"],
    [0.004, "<1%"],
    [0, "0%"],
  ])("formats share %d as %s", (share, text) => {
    expect(formatAgentInputShare(share)).toBe(text);
  });
});

describe("agentInputLayerWhen", () => {
  it("prefers the request number, counted from 1", () => {
    expect(agentInputLayerWhen(layer("a", "tools", 1, { requestIndex: 0 }))).toEqual({
      type: "request",
      label: "Request 1",
    });
  });

  it("falls back to the time, then to nothing", () => {
    expect(agentInputLayerWhen(layer("a", "tools", 1, { at: "2026-11-17T10:00:00.000Z" }))).toEqual(
      { type: "time", at: "2026-11-17T10:00:00.000Z" },
    );
    expect(agentInputLayerWhen(layer("a", "tools", 1))).toBeNull();
  });
});

describe("agentInputTextTargetKey", () => {
  it("tells layers and request parts apart", () => {
    expect(agentInputTextTargetKey({ type: "layer", layerId: "a" })).toBe("layer:a");
    expect(agentInputTextTargetKey({ type: "request", index: 2, part: "tools" })).toBe(
      "request:2:tools",
    );
  });
});

describe("agentInputProfileEffectRows", () => {
  const use: AgentInputProfileUse = {
    profileId: "p1",
    profileName: "Lean",
    appliedAt: "2026-11-17T10:00:00.000Z",
    effects: [{ toggle: "skill", name: "pdf", state: "applied", detail: "Hidden." }],
  };

  it("shows what was asked, the result, the switch and the reason for each entry", () => {
    const rows = agentInputProfileEffectRows({
      ...use,
      driver: ProviderDriverKind.make("codex"),
      applied: [
        {
          kind: "global-instructions",
          requested: "add",
          result: "applied",
          how: "turn additionalContext",
        },
        {
          kind: "agent",
          name: "reviewer",
          requested: "off",
          result: "not-supported",
          how: "none",
          reason: "Codex can only turn all agents off.",
        },
        { kind: "mcpServer", name: "t3-code", requested: "off", result: "skipped", how: "none" },
      ],
    });
    expect(rows).toEqual([
      {
        key: "global-instructions:",
        item: "Global instructions",
        asked: "Add",
        result: "Applied",
        tone: "success",
        how: "turn additionalContext",
      },
      {
        key: "agent:reviewer",
        item: "Agent reviewer",
        asked: "Turn off",
        result: "Not supported",
        tone: "warning",
        how: "none",
        reason: "Codex can only turn all agents off.",
      },
      {
        key: "mcpServer:t3-code",
        item: "MCP server t3-code",
        asked: "Turn off",
        result: "Skipped",
        tone: "secondary",
        how: "none",
      },
    ]);
  });

  it("falls back to the short effects of an older server", () => {
    expect(agentInputProfileEffectRows(use)).toEqual([
      {
        key: "skill:pdf",
        item: "Skill pdf",
        result: "Applied",
        tone: "success",
        how: "Hidden.",
      },
    ]);
  });
});
