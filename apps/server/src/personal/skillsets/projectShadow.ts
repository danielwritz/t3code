/* oxlint-disable t3code/no-global-process-runtime -- Junction semantics are chosen before any provider runtime exists. */
// @effect-diagnostics nodeBuiltinImport:off -- Native links: junctions for folders, links for files.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Project files that steer an agent: repo instructions, skills, rules, hooks and MCP. */
const PROJECT_INSTRUCTION_ENTRIES: ReadonlySet<string> = new Set([
  "GEMINI.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".agents",
  ".agent",
  "_agents",
  "_agent",
  ".gemini",
  ".claude",
]);
const NOT_SCANNED = new Set([".git", "node_modules"]);
const SCAN_LIMIT = 200_000;

/** Folders (relative, `/`-separated) that hold a project instruction entry somewhere below. */
async function foldersWithInstructions(root: string): Promise<Set<string>> {
  const found = new Set<string>();
  let seen = 0;
  const walk = async (relative: string): Promise<void> => {
    const entries = await NodeFSP.readdir(NodePath.join(root, relative), {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      if (++seen > SCAN_LIMIT) throw new Error(`Project has more than ${SCAN_LIMIT} entries`);
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (PROJECT_INSTRUCTION_ENTRIES.has(entry.name)) {
        for (let folder = relative; folder; folder = NodePath.posix.dirname(folder)) {
          found.add(folder);
          if (!folder.includes("/")) break;
        }
        continue;
      }
      if (entry.isDirectory() && !NOT_SCANNED.has(entry.name)) await walk(child);
    }
  };
  await walk("");
  return found;
}

async function sameFile(left: string, right: string) {
  const [a, b] = await Promise.all([
    NodeFSP.stat(left).catch(() => undefined),
    NodeFSP.lstat(right).catch(() => undefined),
  ]);
  return !!a && !!b && !b.isSymbolicLink() && a.ino === b.ino && a.dev === b.dev;
}

async function removeLink(path: string) {
  const info = await NodeFSP.lstat(path);
  if (info.isSymbolicLink() && NodeOS.platform() === "win32")
    await NodeFSP.rmdir(path).catch(() => NodeFSP.unlink(path));
  else await NodeFSP.unlink(path);
}

/**
 * Mirrors `source` into `target` without its project instruction files: folders are junctions,
 * files hard links, so every edit lands in the real checkout. Folders that hold instruction files
 * deeper down are real folders, mirrored the same way. Entries the agent created inside the mirror
 * (no link to the source) are kept and returned.
 */
export async function buildProjectShadow(source: string, target: string) {
  const recurse = await foldersWithInstructions(source);
  const created: string[] = [];
  const mirror = async (relative: string) => {
    const from = NodePath.join(source, relative);
    const to = NodePath.join(target, relative);
    await NodeFSP.mkdir(to, { recursive: true });
    const wanted = new Map(
      (await NodeFSP.readdir(from, { withFileTypes: true }))
        .filter((entry) => !PROJECT_INSTRUCTION_ENTRIES.has(entry.name))
        .map((entry) => [entry.name, entry] as const),
    );
    for (const name of await NodeFSP.readdir(to)) {
      if (wanted.has(name)) continue;
      const path = NodePath.join(to, name);
      // A link the source no longer has goes; anything else was made inside the mirror.
      if ((await NodeFSP.lstat(path)).isSymbolicLink()) await removeLink(path);
      else created.push(NodePath.join(relative, name));
    }
    for (const [name, entry] of wanted) {
      const child = relative ? `${relative}/${name}` : name;
      const real = NodePath.join(from, name);
      const path = NodePath.join(to, name);
      const existing = await NodeFSP.lstat(path).catch(() => undefined);
      if (entry.isDirectory() && recurse.has(child)) {
        if (existing?.isSymbolicLink()) await removeLink(path);
        await mirror(child);
        continue;
      }
      if (entry.isFile()) {
        if (existing?.isSymbolicLink()) {
          if ((await NodeFSP.realpath(path).catch(() => "")) === (await NodeFSP.realpath(real)))
            continue;
          await removeLink(path);
        } else if (existing) {
          if (await sameFile(real, path)) continue;
          // The checkout replaced the file (new inode): relink, unless the mirror copy is newer.
          const [mine, theirs] = await Promise.all([NodeFSP.stat(path), NodeFSP.stat(real)]);
          if (mine.mtimeMs > theirs.mtimeMs) {
            created.push(NodePath.join(relative, name));
            continue;
          }
          await removeLink(path);
        }
        // A file link resolves to the checkout, so T3's file-read check accepts it; Windows
        // without symlink rights gets a hard link instead.
        await NodeFSP.symlink(await NodeFSP.realpath(real), path, "file").catch((error) =>
          (error as NodeJS.ErrnoException).code === "EPERM"
            ? NodeFSP.link(real, path)
            : Promise.reject(error),
        );
        continue;
      }
      if (existing?.isSymbolicLink()) {
        if ((await NodeFSP.realpath(path).catch(() => "")) === (await NodeFSP.realpath(real)))
          continue;
        await removeLink(path);
      } else if (existing) {
        created.push(NodePath.join(relative, name));
        continue;
      }
      const directory = (await NodeFSP.stat(real)).isDirectory();
      await NodeFSP.symlink(
        await NodeFSP.realpath(real),
        path,
        directory ? (NodeOS.platform() === "win32" ? "junction" : "dir") : "file",
      );
    }
  };
  await mirror("");
  return { created };
}

function gitRoots(cwd: string) {
  return new Promise<{ readonly workTree: string; readonly gitDir: string } | undefined>(
    (resolve) =>
      NodeChildProcess.execFile(
        "git",
        ["rev-parse", "--show-toplevel", "--absolute-git-dir"],
        { cwd, windowsHide: true },
        (error, stdout) => {
          const [workTree, gitDir] = stdout.trim().split(/\r?\n/);
          resolve(error || !workTree || !gitDir ? undefined : { workTree, gitDir });
        },
      ),
  );
}

/**
 * The thread's working folder with project instructions hidden ("ignore project instructions"):
 * a mirror of `cwd` under `root`, one per project folder. Git in the mirror is pointed at the real
 * checkout, so status, diffs and commits see the real files, hidden ones included.
 */
export async function ignoreProjectWorkspace(cwd: string, root: string) {
  const target = NodePath.join(
    root,
    NodeCrypto.createHash("sha256").update(NodePath.resolve(cwd)).digest("hex").slice(0, 24),
  );
  const { created } = await buildProjectShadow(cwd, target);
  const git = await gitRoots(cwd);
  return {
    cwd: target,
    created,
    environment: git ? { GIT_DIR: git.gitDir, GIT_WORK_TREE: git.workTree } : {},
  };
}
