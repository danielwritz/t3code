// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Pure Node filesystem/process modules are tested on native links and injected time.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { checkSeams, type Seam } from "./seams.ts";
it("checks every recorded upstream seam", async () => {
  const root = NodePath.resolve(import.meta.dirname, "../../../../..");
  await checkSeams(
    root,
    JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, "personal/skill-sets.seams.json"), "utf8"),
    ) as Seam[],
  );
});
it("names a lost marker and accepts generated files without markers", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "seams-"));
  await NodeFSP.writeFile(NodePath.join(root, "file"), "content");
  await expect(
    checkSeams(root, [{ file: "file", marker: "absent", connects: "thread pick" }]),
  ).rejects.toThrow("thread pick");
  await expect(
    checkSeams(root, [{ file: "file", generated: true, connects: "generated" }]),
  ).resolves.toBeUndefined();
});
