// @effect-diagnostics nodeBuiltinImport:off -- Native canonical paths enforce the checkout boundary before asset minting.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { isProjectFaviconPath } from "@t3tools/shared/projectFavicon";

export async function findSkillSetLogo(checkout: string, configured?: string) {
  const cwd = await NodeFSP.realpath(checkout).catch(() => undefined);
  if (!cwd) return;
  const candidates = configured
    ? [configured]
    : ["assets/logo", "logo", "icon", ".github/logo"].flatMap((base) =>
        ["svg", "png", "webp", "jpg", "jpeg", "gif", "ico"].map(
          (extension) => `${base}.${extension}`,
        ),
      );
  for (const candidate of candidates) {
    if (NodePath.isAbsolute(candidate) || !isProjectFaviconPath(candidate)) continue;
    const canonical = await NodeFSP.realpath(NodePath.resolve(cwd, candidate)).catch(
      () => undefined,
    );
    if (!canonical || !isProjectFaviconPath(canonical)) continue;
    const relative = NodePath.relative(cwd, canonical);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(".." + NodePath.sep) ||
      NodePath.isAbsolute(relative)
    )
      continue;
    if (!(await NodeFSP.stat(canonical)).isFile()) continue;
    return { cwd, path: relative.split(NodePath.sep).join("/") };
  }
}
