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
      error: "Skill pdf is listed twice.",
    });
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
      name: "None",
      source: "None",
      label: "Profile: None",
    });
    expect(
      threadProfileChoice({ ...base, source: "project", projectProfileId: "p1", profile }),
    ).toEqual({ name: "Lean", source: "Project", label: "Profile: Lean · Project" });
    expect(
      threadProfileChoice({ ...base, source: "thread", threadProfileId: "p1", profile }),
    ).toEqual({ name: "Lean", source: "This thread", label: "Profile: Lean · This thread" });
    expect(threadProfileChoice({ ...base, source: "default", profile })).toEqual({
      name: "Lean",
      source: "Default",
      label: "Profile: Lean · Default",
    });
  });
});
