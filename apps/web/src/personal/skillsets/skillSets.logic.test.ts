import { describe, expect, it } from "vite-plus/test";
import type { SkillSetConfig, SkillSetStatus } from "@t3tools/contracts";
import { activeSkillSet, joinSkillSets, newSkillSet, skillSetIdFromName } from "./skillSets.logic";

const alpha: SkillSetConfig = {
  name: "Alpha Kit",
  source: { kind: "local", path: "/skills" },
  enabled: true,
  autoSync: false,
  disabledSkills: ["hidden"],
};
const status: SkillSetStatus = {
  id: "alpha",
  state: "local",
  commit: null,
  commitDate: null,
  lastChecked: null,
  error: null,
  skills: [
    { name: "hidden", description: "A skill", commandOnly: true, targetPath: "/skills/hidden" },
  ],
};

describe("skill set presentation and picks", () => {
  it("joins inventories by id and preserves disabled entries for settings", () => {
    const sets = joinSkillSets(
      { alpha, beta: { ...alpha, name: "Beta", enabled: false } },
      [status],
      "alpha",
    );
    expect(sets[0]).toMatchObject({
      id: "alpha",
      isDefault: true,
      status,
      skills: [{ name: "hidden", enabled: false, manualOnly: true }],
    });
    expect(sets[1]?.skills).toEqual([]);
  });
  it("resolves separate thread and draft picks without replacing an invalid explicit pick", () => {
    const sets = joinSkillSets({ alpha, beta: { ...alpha, name: "Beta" } }, [], "alpha");
    expect(activeSkillSet(true, sets, undefined, "alpha")?.id).toBe("alpha");
    expect(activeSkillSet(true, sets, "beta", "alpha")?.id).toBe("beta");
    expect(activeSkillSet(true, sets, null, "alpha")?.id).toBe("alpha");
    expect(activeSkillSet(true, sets, "missing", "alpha")).toBeUndefined();
    expect(activeSkillSet(false, sets, "beta", "alpha")).toBeUndefined();
    expect(
      activeSkillSet(
        true,
        sets.map((set) => ({ ...set, enabled: false })),
        "beta",
        "alpha",
      ),
    ).toBeUndefined();
  });
});

describe("registering sets", () => {
  it("derives a stable safe id and rejects duplicate or blank names and invalid sources", () => {
    expect(skillSetIdFromName("  Alpha / Kit!  ")).toBe("alpha-kit");
    expect(newSkillSet("Alpha Kit", "github.com/team/skills", {})).toMatchObject({
      id: "alpha-kit",
      config: { source: { kind: "git", url: "https://github.com/team/skills" } },
    });
    expect(newSkillSet("Local", "C:\\work\\skills", {})).toMatchObject({
      config: { source: { kind: "local", path: "C:\\work\\skills" } },
    });
    expect(newSkillSet("SSH", "git@example.org:team/skills.git", {})).toMatchObject({
      config: { source: { kind: "git" } },
    });
    expect(newSkillSet("SSH URL", "ssh://git@example.org/team/skills.git", {})).toMatchObject({
      config: { source: { kind: "git" } },
    });
    for (const [name, source, existing] of [
      ["", "/skills", {}],
      ["Alpha", "garbage", {}],
      ["Alpha", "/skills", { alpha }],
      ["Alpha", "https://", {}],
    ] as const) {
      expect(newSkillSet(name, source, existing)).toHaveProperty("error");
    }
  });
});
