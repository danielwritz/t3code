// @effect-diagnostics nodeBuiltinImport:off -- Real folders and links.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { buildProjectShadow } from "./projectShadow.ts";
import { write } from "./testFakeMachine.ts";

async function project() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "project-shadow-"));
  const source = NodePath.join(root, "project");
  for (const [file, text] of [
    ["GEMINI.md", "repo rules"],
    ["AGENTS.md", "repo rules"],
    ["CLAUDE.md", "repo rules"],
    [".agents/skills/repo-skill/SKILL.md", "skill"],
    [".gemini/settings.json", "{}"],
    ["README.md", "readme"],
    ["src/main.txt", "main"],
    ["packages/app/GEMINI.md", "nested rules"],
    ["packages/app/.agents/rules/rule.md", "rule"],
    ["packages/app/index.txt", "index"],
    ["packages/lib/lib.txt", "lib"],
  ] as const)
    await write(NodePath.join(source, file), text);
  return { root, source, target: NodePath.join(root, "shadow") };
}

const list = (path: string) => NodeFSP.readdir(path).then((names) => names.toSorted());

it("mirrors a project without its instruction files, at the top and deeper down", async () => {
  const { source, target } = await project();
  expect(await buildProjectShadow(source, target)).toEqual({ created: [] });
  expect(await list(target)).toEqual(["README.md", "packages", "src"]);
  expect(await list(NodePath.join(target, "packages", "app"))).toEqual(["index.txt"]);
  expect(await list(NodePath.join(target, "packages", "lib"))).toEqual(["lib.txt"]);
  // Untouched folders are links to the checkout; folders with instructions below are real.
  expect((await NodeFSP.lstat(NodePath.join(target, "src"))).isSymbolicLink()).toBe(true);
  expect((await NodeFSP.lstat(NodePath.join(target, "packages"))).isSymbolicLink()).toBe(false);
  expect(await list(source)).toContain("GEMINI.md");
});

it("sends every edit made through the mirror to the checkout", async () => {
  const { source, target } = await project();
  await buildProjectShadow(source, target);
  await NodeFSP.writeFile(NodePath.join(target, "README.md"), "readme edited");
  await NodeFSP.writeFile(NodePath.join(target, "src", "main.txt"), "main edited");
  await NodeFSP.writeFile(NodePath.join(target, "packages", "app", "index.txt"), "index edited");
  await NodeFSP.writeFile(NodePath.join(target, "src", "new.txt"), "new");
  for (const [file, text] of [
    ["README.md", "readme edited"],
    ["src/main.txt", "main edited"],
    ["packages/app/index.txt", "index edited"],
    ["src/new.txt", "new"],
  ] as const)
    expect(await NodeFSP.readFile(NodePath.join(source, file), "utf8")).toBe(text);
});

it("follows the checkout on rebuild and keeps what was made inside the mirror", async () => {
  const { source, target } = await project();
  await buildProjectShadow(source, target);
  await NodeFSP.rm(NodePath.join(source, "src"), { recursive: true });
  await write(NodePath.join(source, "docs", "guide.txt"), "guide");
  // A checkout that replaces a file (temp file + rename) must not leave the mirror on old content.
  await write(NodePath.join(source, "README.next"), "readme replaced");
  await NodeFSP.rename(NodePath.join(source, "README.next"), NodePath.join(source, "README.md"));
  await NodeFSP.writeFile(NodePath.join(target, "made-here.txt"), "agent file");
  const rebuilt = await buildProjectShadow(source, target);
  expect(rebuilt.created).toEqual(["made-here.txt"]);
  expect(await list(target)).toEqual(["README.md", "docs", "made-here.txt", "packages"]);
  expect(await NodeFSP.readFile(NodePath.join(target, "README.md"), "utf8")).toBe(
    "readme replaced",
  );
  expect(await NodeFSP.readFile(NodePath.join(target, "made-here.txt"), "utf8")).toBe("agent file");
});
