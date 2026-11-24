// @effect-diagnostics nodeBuiltinImport:off -- Native links and files are the subject of these tests.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { acceptOwnedEntries, buildSkillSetHome, type OwnedEntries } from "./home.ts";

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "owned-home-"));
  const home = NodePath.join(root, "real");
  const output = NodePath.join(root, "built");
  await NodeFSP.mkdir(NodePath.join(home, "commands"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(home, "settings.json"), '{"model":"real","hooks":{}}');
  await NodeFSP.writeFile(NodePath.join(home, "INSTRUCTIONS.md"), "real rules");
  await NodeFSP.writeFile(NodePath.join(home, "commands", "real.md"), "real command");
  await NodeFSP.writeFile(NodePath.join(home, "login"), "secret");
  return { home, output };
}
const build = (paths: { home: string; output: string }, owned: OwnedEntries) =>
  buildSkillSetHome({
    realHome: paths.home,
    outputPath: paths.output,
    skillsEntry: "skills",
    skills: [],
    owned,
  });
const isLink = async (path: string) => (await NodeFSP.lstat(path)).isSymbolicLink();

describe("owned home entries", () => {
  it("writes owned files and folders as real files, leaves out absent parts and links the rest", async () => {
    const paths = await fixture();
    const before = await NodeFSP.readFile(NodePath.join(paths.home, "settings.json"), "utf8");
    await build(paths, {
      "settings.json": { kind: "file", contents: '{"model":"real","hooks":{"Stop":[]}}' },
      commands: { kind: "directory", files: { "alpha.md": "alpha", "nested/beta.md": "beta" } },
      "INSTRUCTIONS.md": null,
    });
    const settings = NodePath.join(paths.output, "settings.json");
    expect(await isLink(settings)).toBe(false);
    expect(await NodeFSP.readFile(settings, "utf8")).toBe('{"model":"real","hooks":{"Stop":[]}}');
    expect(await isLink(NodePath.join(paths.output, "commands"))).toBe(false);
    expect(await NodeFSP.readdir(NodePath.join(paths.output, "commands"))).toEqual([
      "alpha.md",
      "nested",
    ]);
    expect(
      await NodeFSP.readFile(NodePath.join(paths.output, "commands", "nested", "beta.md"), "utf8"),
    ).toBe("beta");
    await expect(NodeFSP.lstat(NodePath.join(paths.output, "INSTRUCTIONS.md"))).rejects.toThrow();
    expect(await isLink(NodePath.join(paths.output, "login"))).toBe(true);
    expect(await NodeFSP.readFile(NodePath.join(paths.home, "settings.json"), "utf8")).toBe(before);
    expect(await NodeFSP.readdir(NodePath.join(paths.home, "commands"))).toEqual(["real.md"]);
  });

  it("replaces links left by an older build and removes its own copy when the part goes away", async () => {
    const paths = await fixture();
    await build(paths, {});
    expect(await isLink(NodePath.join(paths.output, "INSTRUCTIONS.md"))).toBe(true);
    await build(paths, { "INSTRUCTIONS.md": { kind: "file", contents: "profile rules" } });
    expect(await isLink(NodePath.join(paths.output, "INSTRUCTIONS.md"))).toBe(false);
    expect(await NodeFSP.readFile(NodePath.join(paths.output, "INSTRUCTIONS.md"), "utf8")).toBe(
      "profile rules",
    );
    await build(paths, { "INSTRUCTIONS.md": null });
    await expect(NodeFSP.lstat(NodePath.join(paths.output, "INSTRUCTIONS.md"))).rejects.toThrow();
    expect(await NodeFSP.readFile(NodePath.join(paths.home, "INSTRUCTIONS.md"), "utf8")).toBe(
      "real rules",
    );
  });

  it("names the changed keys of a write into an owned copy once, then overwrites it", async () => {
    const paths = await fixture();
    const owned = {
      "settings.json": { kind: "file" as const, contents: '{"model":"real","hooks":{}}' },
    };
    expect((await build(paths, owned)).ownedChanges).toEqual([]);
    await NodeFSP.writeFile(
      NodePath.join(paths.output, "settings.json"),
      '{"model":"changed-in-session","hooks":{}}',
    );
    expect((await build(paths, owned)).ownedChanges).toEqual([
      { entry: "settings.json", keys: ["model"] },
    ]);
    expect(await NodeFSP.readFile(NodePath.join(paths.output, "settings.json"), "utf8")).toBe(
      '{"model":"real","hooks":{}}',
    );
    expect((await build(paths, owned)).ownedChanges).toEqual([]);
  });

  it("accepts a provider's own edit of an owned copy as the new baseline", async () => {
    const paths = await fixture();
    const owned = { "config.toml": { kind: "file" as const, contents: 'model = "real"\n' } };
    await build(paths, owned);
    await NodeFSP.writeFile(
      NodePath.join(paths.output, "config.toml"),
      'model = "real"\n[mcp_servers.alpha]\ncommand = "alpha"\n',
    );
    await acceptOwnedEntries(paths.output, ["config.toml"]);
    await NodeFSP.writeFile(
      NodePath.join(paths.output, "config.toml"),
      'model = "real"\n[mcp_servers.alpha]\ncommand = "alpha"\n[notice]\nseen = true\n',
    );
    expect((await build(paths, owned)).ownedChanges).toEqual([
      { entry: "config.toml", keys: ["notice"] },
    ]);
  });

  it("keeps a real file it did not write at an owned name the profile leaves out", async () => {
    const paths = await fixture();
    await NodeFSP.mkdir(paths.output, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(paths.output, "INSTRUCTIONS.md"), "made by the program");
    const result = await build(paths, { "INSTRUCTIONS.md": null });
    expect(result.foreignEntries).toContain("INSTRUCTIONS.md");
    expect(await NodeFSP.readFile(NodePath.join(paths.output, "INSTRUCTIONS.md"), "utf8")).toBe(
      "made by the program",
    );
  });

  it("refuses owned paths that leave the built home", async () => {
    const paths = await fixture();
    await expect(
      build(paths, { commands: { kind: "directory", files: { "../escape.md": "x" } } }),
    ).rejects.toThrow("Invalid");
    await expect(build(paths, { "../escape": null })).rejects.toThrow("Invalid");
  });
});
