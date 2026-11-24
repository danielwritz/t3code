// @effect-diagnostics nodeBuiltinImport:off -- Native links supplement the provider-specific home layout.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export async function linkClaudeGlobalConfig(home: string, userHome: string) {
  // Unlike custom config dirs, the default home keeps global MCP/login metadata beside .claude.
  const target = NodePath.join(userHome, ".claude.json");
  if (!(await NodeFSP.lstat(target).catch(() => undefined))) return;
  const destination = NodePath.join(home, ".claude.json");
  const existing = await NodeFSP.lstat(destination).catch(() => undefined);
  if (existing) {
    if (
      existing.isSymbolicLink() &&
      (await NodeFSP.realpath(destination)) === (await NodeFSP.realpath(target))
    )
      return;
    throw new Error("Claude global config link is no longer shared");
  }
  await NodeFSP.symlink(target, destination, "file").catch(async (error: NodeJS.ErrnoException) => {
    if (
      error.code === "EEXIST" &&
      (await NodeFSP.lstat(destination)).isSymbolicLink() &&
      (await NodeFSP.realpath(destination)) === (await NodeFSP.realpath(target))
    )
      return;
    throw error;
  });
}
