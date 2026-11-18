import type { AgentInputLayer, AgentInputProfileUse, AgentInputRequest } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentInputFidelitySentence,
  agentInputLayerTitle,
  agentInputLayerWhen,
  agentInputProfileEffectRows,
  agentInputOwnerShares,
  agentInputProfileNeedsDetails,
  agentInputProfileSentence,
  agentInputSummarySentence,
  agentInputTextTargetKey,
  formatAgentInputChars,
  formatAgentInputShare,
  groupAgentInputLayers,
  agentInputTargetInTrace,
  withRequestChecks,
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

describe("agentInputOwnerShares", () => {
  it("sorts every layer under the agent, T3 Code or you by who wrote it", () => {
    const shares = agentInputOwnerShares([
      layer("sys", "system-prompt", 600),
      layer("t3-tools", "tools", 200, { origin: "t3" }),
      layer("claude-md", "instruction-file", 50, { origin: "user-file" }),
      layer("docs", "tools", 100, { origin: "mcp-server" }),
      layer("prompt", "user-prompt", 50, { origin: "user" }),
    ]);
    expect(shares.map((share) => [share.owner, share.chars, share.share])).toEqual([
      ["agent", 600, 0.6],
      ["t3", 200, 0.2],
      ["you", 200, 0.2],
    ]);
  });

  it("keeps all three owners, with no share when there is nothing", () => {
    expect(agentInputOwnerShares([]).map((share) => [share.owner, share.share])).toEqual([
      ["agent", 0],
      ["t3", 0],
      ["you", 0],
    ]);
  });
});

describe("agentInputSummarySentence", () => {
  const shares = (agent: number, t3: number, you: number) =>
    agentInputOwnerShares([
      layer("a", "system-prompt", agent),
      layer("t", "host-instructions", t3, { origin: "t3" }),
      layer("y", "user-prompt", you, { origin: "user" }),
    ]);
  const t3Off: AgentInputProfileUse = {
    profileId: "p1",
    profileName: "Interface only",
    appliedAt: "2026-11-17T10:00:00.000Z",
    effects: [],
    applied: [{ kind: "host", requested: "off", result: "applied", how: "left out" }],
  };

  it("says how much each owner put in front of the agent", () => {
    expect(agentInputSummarySentence("Claude", shares(118_800, 10_200, 146))).toBe(
      "Claude was given 129.1k characters: 118.8k from Claude itself, 10.2k from T3 Code and 146 from you.",
    );
  });

  it("names the profile that switched T3 Code off", () => {
    expect(agentInputSummarySentence("Claude", shares(128_800, 0, 146), t3Off)).toBe(
      'Claude was given 128.9k characters: 128.8k from Claude itself, nothing from T3 Code (switched off by profile "Interface only") and 146 from you.',
    );
    expect(agentInputSummarySentence("Codex", shares(500, 0, 0))).toBe(
      "Codex was given 500 characters: 500 from Codex itself, nothing from T3 Code and nothing from you.",
    );
  });
});

describe("agentInputProfileSentence", () => {
  const use = (applied: AgentInputProfileUse["applied"]): AgentInputProfileUse => ({
    profileId: "p1",
    profileName: "Bottom-up",
    appliedAt: "2026-11-17T10:00:00.000Z",
    effects: [],
    applied,
  });
  const instructions = [layer("profile", "profile", 247, { origin: "profile" })];

  it("says what the profile added and turned off", () => {
    const profile = use([
      { kind: "global-instructions", requested: "add", result: "applied", how: "append" },
      { kind: "skill", name: "*", requested: "off", result: "applied", how: "flag" },
      { kind: "mcpServer", name: "docs", requested: "off", result: "applied", how: "flag" },
    ]);
    expect(agentInputProfileSentence(profile, instructions)).toBe(
      'Profile "Bottom-up" added 247 characters of your instructions and turned off 2 of your items.',
    );
    expect(agentInputProfileNeedsDetails(profile)).toBe(false);
  });

  it("says T3 Code added nothing when the profile switched it off", () => {
    expect(
      agentInputProfileSentence(
        use([{ kind: "host", requested: "off", result: "applied", how: "left out" }]),
        [],
      ),
    ).toBe('Profile "Bottom-up" is on: T3 Code added nothing to this thread.');
  });

  it("points to the details when a switch was not applied", () => {
    const profile = use([
      {
        kind: "agent",
        name: "reviewer",
        requested: "off",
        result: "not-supported",
        how: "none",
        reason: "Codex can only turn all agents off.",
      },
    ]);
    expect(agentInputProfileSentence(profile, [])).toBe(
      'Profile "Bottom-up" is on but changed nothing for this agent. 1 switch was not applied; see Details.',
    );
    expect(agentInputProfileNeedsDetails(profile)).toBe(true);
  });
});

describe("agentInputFidelitySentence", () => {
  it.each([
    ["exact", "Rebuilt from the agent's own request record and checked against its digest"],
    ["harness-record", "From the agent's own session record"],
    ["t3-recorded", "Only what T3 Code sent; this agent keeps no readable record"],
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

describe("agentInputLayerTitle", () => {
  it.each([
    ["Section: multi_agent_role", "Multi agent role", "multi_agent_role"],
    ["Section: t3_code_orchestration_01", "T3 Code orchestration 1", "t3_code_orchestration_01"],
    ["Section: mcp_servers", "MCP servers", "mcp_servers"],
    ["Section: identity", "Identity", "identity"],
  ])("reads the section tag %s as %s", (title, readable) => {
    expect(agentInputLayerTitle(layer("a", "system-prompt", 1, { title }))).toBe(readable);
  });

  it("keeps other titles and falls back to the preview, then the id", () => {
    expect(agentInputLayerTitle(layer("a", "tools", 1, { title: "Tools (20)" }))).toBe(
      "Tools (20)",
    );
    expect(agentInputLayerTitle(layer("a", "tools", 1, { title: "", preview: "hi" }))).toBe("hi");
    expect(agentInputLayerTitle(layer("a", "tools", 1, { title: "" }))).toBe("a");
  });
});

describe("agentInputTargetInTrace", () => {
  const trace = {
    layers: [layer("a", "tools", 1)],
    requests: [
      {
        index: 0,
        systemChars: 1,
        toolCount: 0,
        toolChars: 0,
        messageCount: 1,
        verification: "verified" as const,
      },
    ],
  };

  it("drops a selection that a refreshed trace no longer has", () => {
    expect(agentInputTargetInTrace(trace, { type: "layer", layerId: "a" })).toEqual({
      type: "layer",
      layerId: "a",
    });
    expect(agentInputTargetInTrace(trace, { type: "layer", layerId: "gone" })).toBeNull();
    expect(
      agentInputTargetInTrace(trace, { type: "request", index: 0, part: "tools" }),
    ).not.toBeNull();
    expect(agentInputTargetInTrace(trace, { type: "request", index: 3, part: "tools" })).toBeNull();
    expect(agentInputTargetInTrace(null, { type: "layer", layerId: "a" })).not.toBeNull();
    expect(agentInputTargetInTrace(trace, null)).toBeNull();
  });
});

describe("withRequestChecks", () => {
  const request = (index: number, verification: AgentInputRequest["verification"]) => ({
    index,
    systemChars: 1,
    toolCount: 0,
    toolChars: 0,
    messageCount: 1,
    verification,
  });

  it("shows the result of a part that was read on its request card", () => {
    const requests = [request(0, "not-checked"), request(1, "not-checked"), request(2, "verified")];
    expect(
      withRequestChecks(requests, { 0: "verified", 2: "unverified" }).map((r) => r.verification),
    ).toEqual(["verified", "not-checked", "unverified"]);
    expect(withRequestChecks(requests, {})).toBe(requests);
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
        reason: "Codex can only turn all agents off.",
      },
      {
        key: "mcpServer:t3-code",
        item: "MCP server t3-code",
        asked: "Turn off",
        result: "Skipped",
        tone: "secondary",
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
