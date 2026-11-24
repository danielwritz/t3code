// @effect-diagnostics nodeBuiltinImport:off -- Exercises checkout path containment on the native filesystem.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { findSkillSetLogo } from "./logo.ts";

it("detects repo images and rejects non-images, traversal and escaping links", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "set-logo-"));
  const checkout = NodePath.join(root, "checkout");
  await NodeFSP.mkdir(NodePath.join(checkout, "assets"), { recursive: true });
  expect(await findSkillSetLogo(checkout)).toBeUndefined();
  await NodeFSP.writeFile(
    NodePath.join(checkout, "assets", "logo.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  expect(await findSkillSetLogo(checkout)).toEqual({
    cwd: await NodeFSP.realpath(checkout),
    path: "assets/logo.svg",
  });
  expect(await findSkillSetLogo(checkout, "assets/logo.svg")).toBeDefined();
  await NodeFSP.writeFile(NodePath.join(root, "secret.png"), "outside");
  await NodeFSP.writeFile(NodePath.join(checkout, "login.json"), "private");
  await NodeFSP.symlink(
    NodePath.join(root, "secret.png"),
    NodePath.join(checkout, "escape.png"),
    "file",
  );
  for (const candidate of [
    "../secret.png",
    NodePath.join(root, "secret.png"),
    "login.json",
    "escape.png",
  ])
    expect(await findSkillSetLogo(checkout, candidate)).toBeUndefined();
});
