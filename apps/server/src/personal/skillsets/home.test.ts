/* oxlint-disable t3code/no-global-process-runtime -- Native filesystem module and tests must choose junction semantics before any provider runtime exists. */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Pure Node filesystem/process modules are tested on native links and injected time.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { buildSkillSetHome } from "./home.ts";

describe("skill set home", () => {
  it("preserves and reports foreign real skill entries across repeated builds", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foreign-home-"));
    const home = NodePath.join(root, "real");
    const output = NodePath.join(root, "built");
    const target = NodePath.join(root, "source");
    const foreign = NodePath.join(output, "skills", "synced");
    await NodeFSP.mkdir(home);
    await NodeFSP.mkdir(target);
    await NodeFSP.mkdir(foreign, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(foreign, "keep"), "untouched");
    await NodeFSP.writeFile(NodePath.join(output, "runtime-state"), "retained");
    await NodeFSP.writeFile(NodePath.join(home, "runtime-state"), "source");
    for (const name of ["alpha", "beta"]) {
      const result = await buildSkillSetHome({
        realHome: home,
        outputPath: output,
        skillsEntry: "skills",
        skills: [{ name, targetPath: target }],
      });
      expect(result).toEqual({
        homePath: output,
        foreignEntries: ["runtime-state", "synced"],
        ownedChanges: [],
      });
      expect(await NodeFSP.realpath(NodePath.join(output, "skills", name))).toBe(
        await NodeFSP.realpath(target),
      );
      expect(await NodeFSP.readFile(NodePath.join(foreign, "keep"), "utf8")).toBe("untouched");
      expect(await NodeFSP.readFile(NodePath.join(output, "runtime-state"), "utf8")).toBe(
        "retained",
      );
    }
  });
  it("repairs links, sees new home files, follows linked sources and removes disabled skills", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "skill-home-"));
    const home = NodePath.join(root, "real");
    const output = NodePath.join(root, "built");
    const skill = NodePath.join(root, "source");
    const alias = NodePath.join(root, "alias");
    await NodeFSP.mkdir(home);
    await NodeFSP.mkdir(skill);
    await NodeFSP.writeFile(NodePath.join(home, "auth"), "secret");
    await NodeFSP.symlink(skill, alias, NodeOS.platform() === "win32" ? "junction" : "dir");
    await buildSkillSetHome({
      realHome: home,
      outputPath: output,
      skillsEntry: "skills",
      skills: [{ name: "alpha", targetPath: alias }],
    });
    expect(await NodeFSP.realpath(NodePath.join(output, "skills", "alpha"))).toBe(
      await NodeFSP.realpath(skill),
    );
    expect(await NodeFSP.readFile(NodePath.join(output, "auth"), "utf8")).toBe("secret");
    expect(await NodeFSP.realpath(NodePath.join(output, "auth"))).toBe(
      await NodeFSP.realpath(NodePath.join(home, "auth")),
    );
    await NodeFSP.writeFile(NodePath.join(home, "new-file"), "new");
    await NodeFSP.symlink(
      skill,
      NodePath.join(output, "stale"),
      NodeOS.platform() === "win32" ? "junction" : "dir",
    );
    await NodeFSP.mkdir(NodePath.join(home, "stale"));
    await buildSkillSetHome({
      realHome: home,
      outputPath: output,
      skillsEntry: "skills",
      skills: [],
    });
    expect(await NodeFSP.readFile(NodePath.join(output, "new-file"), "utf8")).toBe("new");
    expect(await NodeFSP.realpath(NodePath.join(output, "stale"))).toBe(
      await NodeFSP.realpath(NodePath.join(home, "stale")),
    );
    await expect(NodeFSP.realpath(NodePath.join(output, "skills", "alpha"))).rejects.toThrow();
    expect(await NodeFSP.readFile(NodePath.join(home, "auth"), "utf8")).toBe("secret");
  });
});
it("refuses an output routed through a link into the real home", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "home-guard-"));
  const home = NodePath.join(root, "real");
  await NodeFSP.mkdir(home);
  const alias = NodePath.join(root, "alias");
  await NodeFSP.symlink(home, alias, NodeOS.platform() === "win32" ? "junction" : "dir");
  await expect(
    buildSkillSetHome({
      realHome: home,
      outputPath: NodePath.join(alias, "nested"),
      skillsEntry: "skills",
      skills: [],
    }),
  ).rejects.toThrow("outside");
  await expect(NodeFSP.stat(NodePath.join(home, "nested"))).rejects.toThrow();
});
it("shadows nested skill folders without writing through their linked parent", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "nested-home-"));
  const home = NodePath.join(root, "real");
  const output = NodePath.join(root, "built");
  const target = NodePath.join(root, "target");
  await NodeFSP.mkdir(NodePath.join(home, "config", "skills"), { recursive: true });
  await NodeFSP.mkdir(target);
  await NodeFSP.writeFile(NodePath.join(home, "config", "login"), "private");
  await buildSkillSetHome({
    realHome: home,
    outputPath: output,
    skillsEntry: "config/skills",
    skills: [{ name: "alpha", targetPath: target }],
  });
  expect(await NodeFSP.readFile(NodePath.join(output, "config", "login"), "utf8")).toBe("private");
  expect(await NodeFSP.realpath(NodePath.join(output, "config", "skills", "alpha"))).toBe(
    await NodeFSP.realpath(target),
  );
  expect(await NodeFSP.readdir(NodePath.join(home, "config", "skills"))).toEqual([]);
});
