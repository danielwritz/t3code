/* oxlint-disable t3code/no-global-process-runtime -- Native filesystem module and tests must choose junction semantics before any provider runtime exists. */
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Pure Node filesystem/process modules are tested on native links and injected time.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

interface SkillLink {
  readonly name: string;
  readonly targetPath: string;
}
interface HomeInput {
  readonly realHome: string;
  readonly outputPath: string;
  readonly skillsEntry: string;
  readonly skills: readonly SkillLink[];
  readonly privateEntries?: readonly string[];
}

function safeEntry(name: string) {
  if (!name || name === "." || name === ".." || /[\\/]/.test(name))
    throw new Error(`Invalid entry: ${name}`);
}

async function link(target: string, destination: string) {
  const canonical = await NodeFSP.realpath(target);
  const existing = await NodeFSP.lstat(destination).catch(() => undefined);
  if (existing) {
    if (!existing.isSymbolicLink()) throw new Error(`Refusing to replace non-link: ${destination}`);
    if ((await NodeFSP.realpath(destination).catch(() => undefined)) === canonical) return;
    await NodeFSP.rm(destination);
  }
  const directory = (await NodeFSP.lstat(canonical)).isDirectory();
  await NodeFSP.symlink(
    canonical,
    destination,
    directory ? (NodeOS.platform() === "win32" ? "junction" : "dir") : "file",
  );
}

async function canonicalOutput(path: string): Promise<string> {
  try {
    return await NodeFSP.realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = NodePath.dirname(path);
    if (parent === path) throw error;
    return NodePath.join(await canonicalOutput(parent), NodePath.basename(path));
  }
}
function contains(parent: string, child: string) {
  const relative = NodePath.relative(parent, child);
  return (
    !relative ||
    (relative !== ".." &&
      !relative.startsWith(".." + NodePath.sep) &&
      !NodePath.isAbsolute(relative))
  );
}
/** Only mutates the managed output. Targets and the real home are always read-only. */
export async function buildSkillSetHome(input: HomeInput) {
  const skillParts = input.skillsEntry.split(/[\\/]/);
  for (const part of skillParts) safeEntry(part);
  for (const skill of input.skills) safeEntry(skill.name);
  const home = await NodeFSP.realpath(input.realHome);
  if ((await NodeFSP.lstat(input.outputPath).catch(() => undefined))?.isSymbolicLink())
    throw new Error("Output cannot be a link");
  const output = await canonicalOutput(NodePath.resolve(input.outputPath));
  if (contains(home, output) || contains(output, home))
    throw new Error("Output must be outside real home");
  for (const skill of input.skills) {
    const target = await NodeFSP.realpath(skill.targetPath);
    if (contains(target, output) || contains(output, target))
      throw new Error("Output must be outside skill targets");
  }
  await NodeFSP.mkdir(output, { recursive: true });
  if ((await NodeFSP.lstat(output)).isSymbolicLink()) throw new Error("Output cannot be a link");
  const excluded = new Set([skillParts[0], ...(input.privateEntries ?? [])]);
  for (const name of input.privateEntries ?? []) {
    safeEntry(name);
    const privatePath = NodePath.join(output, name);
    if ((await NodeFSP.lstat(privatePath).catch(() => undefined))?.isSymbolicLink())
      await NodeFSP.rm(privatePath);
  }
  for (const entry of await NodeFSP.readdir(home)) {
    if (!excluded.has(entry)) await link(NodePath.join(home, entry), NodePath.join(output, entry));
  }
  let sourceParent = home;
  let outputParent = output;
  for (let index = 0; index < skillParts.length - 1; index++) {
    sourceParent = NodePath.join(sourceParent, skillParts[index]!);
    outputParent = NodePath.join(outputParent, skillParts[index]!);
    if ((await NodeFSP.lstat(outputParent).catch(() => undefined))?.isSymbolicLink())
      await NodeFSP.rm(outputParent);
    await NodeFSP.mkdir(outputParent, { recursive: true });
    for (const entry of await NodeFSP.readdir(sourceParent).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    )) {
      if (entry !== skillParts[index + 1])
        await link(NodePath.join(sourceParent, entry), NodePath.join(outputParent, entry));
    }
  }
  const skillsDir = NodePath.join(output, ...skillParts);
  const existing = await NodeFSP.lstat(skillsDir).catch(() => undefined);
  if (existing?.isSymbolicLink()) await NodeFSP.rm(skillsDir);
  await NodeFSP.mkdir(skillsDir, { recursive: true });
  const enabled = new Set(input.skills.map((skill) => skill.name));
  const foreignEntries: string[] = [];
  for (const entry of await NodeFSP.readdir(skillsDir)) {
    const path = NodePath.join(skillsDir, entry);
    if (!(await NodeFSP.lstat(path)).isSymbolicLink()) {
      foreignEntries.push(entry);
      continue;
    }
    if (!enabled.has(entry)) {
      await NodeFSP.rm(path);
    }
  }
  for (const skill of input.skills)
    if (!foreignEntries.includes(skill.name))
      await link(skill.targetPath, NodePath.join(skillsDir, skill.name));
  return { homePath: output, foreignEntries };
}
