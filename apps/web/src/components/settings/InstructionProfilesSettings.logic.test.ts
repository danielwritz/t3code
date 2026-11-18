import type {
  InstructionProfile,
  InstructionProfileDriverSupport,
  ThreadInstructionProfile,
} from "@t3tools/contracts";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  draftFromProfile,
  emptyProfileDraft,
  instructionProfileItemLabel,
  instructionProfileSupportRows,
  instructionProfileSummary,
  instructionProfileSupportResult,
  isProfileDraftChanged,
  profileDraftSaveInput,
  threadProfileChoice,
} from "./InstructionProfilesSettings.logic";

const profile: InstructionProfile = {
  id: "p1",
  name: "Lean",
  description: "No plugins",
  globalInstructions: "Be brief.",
  items: [
    { kind: "skill", name: "*", enabled: false },
    { kind: "mcpServer", name: "github", enabled: true },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("profile drafts", () => {
  it("round-trips a saved profile into the save input", () => {
    const draft = draftFromProfile(profile);
    expect(isProfileDraftChanged(draft, profile)).toBe(false);
    expect(profileDraftSaveInput(draft)).toEqual({
      ok: true,
      input: {
        id: "p1",
        name: "Lean",
        description: "No plugins",
        globalInstructions: "Be brief.",
        items: profile.items,
      },
    });
  });

  it("trims names, drops empty item rows and omits the id for a new profile", () => {
    const draft = {
      ...emptyProfileDraft(),
      name: "  Quiet  ",
      items: [
        { key: "a", kind: "agent" as const, name: " reviewer ", enabled: false },
        { key: "b", kind: "skill" as const, name: "   ", enabled: true },
      ],
    };
    expect(profileDraftSaveInput(draft)).toEqual({
      ok: true,
      input: {
        name: "Quiet",
        description: "",
        globalInstructions: "",
        items: [{ kind: "agent", name: "reviewer", enabled: false }],
      },
    });
  });

  it("refuses a draft without a name or with the same item twice", () => {
    expect(profileDraftSaveInput(emptyProfileDraft())).toEqual({
      ok: false,
      error: "Give the profile a name.",
    });
    const twice = {
      ...emptyProfileDraft(),
      name: "Twice",
      items: [
        { key: "a", kind: "skill" as const, name: "pdf", enabled: false },
        { key: "b", kind: "skill" as const, name: "pdf", enabled: true },
      ],
    };
    expect(profileDraftSaveInput(twice)).toEqual({
      ok: false,
      error: "Two switches are for Skill pdf. Remove one.",
    });
  });

  it("refuses a name another profile already has, ignoring case and spaces", () => {
    const others = [profile, { ...profile, id: "p2", name: "Bottom-up replies" }];
    expect(
      profileDraftSaveInput({ ...emptyProfileDraft(), name: " bottom-UP replies " }, others),
    ).toEqual({ ok: false, error: "A profile named Bottom-up replies already exists." });
    // The profile being edited keeps its own name.
    expect(profileDraftSaveInput(draftFromProfile(profile), others).ok).toBe(true);
  });

  it("keeps T3 Code's own switch out of the rows and saves it as one host item", () => {
    const t3Off: InstructionProfile = {
      ...profile,
      items: [...profile.items, { kind: "host", name: "*", enabled: false }],
    };
    const draft = draftFromProfile(t3Off);
    expect(draft.t3).toBe(false);
    expect(draft.items.map((item) => item.kind)).toEqual(["skill", "mcpServer"]);
    expect(isProfileDraftChanged(draft, t3Off)).toBe(false);
    expect(isProfileDraftChanged({ ...draft, t3: true }, t3Off)).toBe(true);
    const saved = profileDraftSaveInput(draft);
    expect(saved.ok && saved.input.items).toEqual(t3Off.items);
    const on = profileDraftSaveInput({ ...draft, t3: true });
    expect(on.ok && on.input.items).toEqual(profile.items);
    expect(emptyProfileDraft().t3).toBe(true);
    expect(draftFromProfile(profile).t3).toBe(true);
  });

  it("sees an edited item as a change", () => {
    const draft = draftFromProfile(profile);
    const edited = {
      ...draft,
      items: draft.items.map((item, index) => (index === 0 ? { ...item, enabled: true } : item)),
    };
    expect(isProfileDraftChanged(edited, profile)).toBe(true);
    expect(isProfileDraftChanged(emptyProfileDraft(), undefined)).toBe(false);
  });
});

describe("instructionProfileItemLabel", () => {
  it("names one item or all items of a kind", () => {
    expect(instructionProfileItemLabel("skill", "pdf")).toBe("Skill pdf");
    expect(instructionProfileItemLabel("mcpServer", "*")).toBe("All MCP servers");
    expect(instructionProfileItemLabel("agent", "*")).toBe("All agents");
    expect(instructionProfileItemLabel("global-instructions", undefined)).toBe(
      "Global instructions",
    );
    expect(instructionProfileItemLabel("host", "*")).toBe("T3 Code's own instructions and tools");
  });
});

describe("instructionProfileSupportRows", () => {
  const row = (
    driver: InstructionProfileDriverSupport["driver"],
    support: "yes" | "partial" | "no",
  ): InstructionProfileDriverSupport => ({
    driver,
    kinds: [
      { kind: "global-instructions", support: "yes", how: "append" },
      { kind: "skill", support, how: support === "no" ? "no switch" : "skill switch" },
    ],
  });

  it("merges drivers with the same switches into one row and names them", () => {
    const rows = instructionProfileSupportRows([
      row(ProviderDriverKind.make("claudeAgent"), "yes"),
      row(ProviderDriverKind.make("antigravity"), "no"),
      row(ProviderDriverKind.make("kiro"), "no"),
      row("*", "partial"),
    ]);
    expect(rows.map((entry) => entry.label)).toEqual([
      "Claude",
      "Antigravity, Kiro",
      "Every other agent",
    ]);
    expect(rows[1]!.cells.map((cell) => [cell.kind, cell.support, cell.how])).toEqual([
      ["global-instructions", "yes", "append"],
      ["skill", "no", "no switch"],
    ]);
  });
});

describe("threadProfileChoice", () => {
  const thread = ThreadId.make("thread-1");
  const base: ThreadInstructionProfile = {
    threadId: thread,
    threadProfileId: null,
    projectProfileId: null,
    defaultProfileId: null,
    source: "none",
  };

  it("says which profile applies and where it comes from", () => {
    expect(threadProfileChoice(base)).toEqual({
      name: "No profile",
      source: "Instruction profile",
      label: "Instruction profile: none",
      interfaceOnly: false,
    });
    expect(
      threadProfileChoice({ ...base, source: "project", projectProfileId: "p1", profile }),
    ).toEqual({
      name: "Lean",
      source: "From the project",
      label: "Instruction profile: Lean, from the project",
      interfaceOnly: false,
    });
    expect(
      threadProfileChoice({ ...base, source: "thread", threadProfileId: "p1", profile }),
    ).toEqual({
      name: "Lean",
      source: "For this thread",
      label: "Instruction profile: Lean, for this thread",
      interfaceOnly: false,
    });
    expect(threadProfileChoice({ ...base, source: "default", profile })).toEqual({
      name: "Lean",
      source: "The default",
      label: "Instruction profile: Lean, the default",
      interfaceOnly: false,
    });
    const interfaceOnly = {
      ...profile,
      items: [{ kind: "host" as const, name: "*", enabled: false }],
    };
    expect(
      threadProfileChoice({ ...base, source: "thread", profile: interfaceOnly }).interfaceOnly,
    ).toBe(true);
  });
});

describe("instructionProfileSummary", () => {
  it("says what agents under the profile get, in plain words", () => {
    expect(instructionProfileSummary(profile)).toBe(
      "Your instructions (9 characters) · T3 Code features · all skills off",
    );
    expect(
      instructionProfileSummary({
        globalInstructions: "  ",
        items: [
          { kind: "skill", name: "pdf", enabled: false },
          { kind: "agent", name: "reviewer", enabled: false },
          { kind: "mcpServer", name: "*", enabled: false },
          { kind: "host", name: "*", enabled: false },
        ],
      }),
    ).toBe(
      "No instructions of your own · Interface only · all MCP servers off, 2 of your items off",
    );
    expect(instructionProfileSummary({ globalInstructions: "", items: [] })).toBe(
      "No instructions of your own · T3 Code features · all your items on",
    );
  });
});

describe("instructionProfileSupportResult", () => {
  it.each([
    ["no", "T3 has no launch-time switch for this provider yet", "Not supported"],
    [
      "yes",
      "system prompt append, so a change applies from the next turn",
      "Works from the next turn",
    ],
    [
      "yes",
      "flag settings; the skill list changes from the next new thread",
      "Works from the next new thread",
    ],
    [
      "partial",
      "config mcp_servers; applies when Codex starts or resumes the thread",
      "Partly works, when the thread starts or resumes",
    ],
    ["yes", "turn additionalContext entry", "Works"],
  ] as const)("%s: %s", (support, how, result) => {
    expect(instructionProfileSupportResult({ kind: "skill", support, how })).toBe(result);
  });
});
