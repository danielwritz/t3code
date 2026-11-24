/* oxlint-disable t3code/no-global-process-runtime -- Native filesystem module and tests must choose junction semantics before any provider runtime exists. */
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Pure Node filesystem/process modules are tested on native links and injected time.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { parse as parseToml } from "smol-toml";

interface SkillLink {
  readonly name: string;
  readonly targetPath: string;
}
/** A top-level entry the built home owns: real files written atomically, never a link. */
export type OwnedEntry =
  | { readonly kind: "file"; readonly contents: string }
  | { readonly kind: "directory"; readonly files: Readonly<Record<string, string>> };
/** Entry name to content; `null` leaves the entry out of the built home (not linked either). */
export type OwnedEntries = Readonly<Record<string, OwnedEntry | null>>;
export interface OwnedChange {
  readonly entry: string;
  /** Changed top-level keys of a JSON or TOML file, when both versions can be read. */
  readonly keys?: readonly string[];
}
interface HomeInput {
  readonly realHome: string;
  readonly outputPath: string;
  readonly skillsEntry: string;
  readonly skills: readonly SkillLink[];
  readonly privateEntries?: readonly string[];
  readonly owned?: OwnedEntries;
}

function safeEntry(name: string) {
  if (!name || name === "." || name === ".." || /[\\/]/.test(name))
    throw new Error(`Invalid entry: ${name}`);
}
function safeRelative(path: string) {
  if (NodePath.isAbsolute(path)) throw new Error(`Invalid owned file: ${path}`);
  for (const part of path.split(/[\\/]/))
    if (!part || part === "." || part === "..") throw new Error(`Invalid owned file: ${path}`);
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
  const owned = input.owned ?? {};
  for (const [name, entry] of Object.entries(owned)) {
    safeEntry(name);
    if (name === skillParts[0]) throw new Error(`Invalid owned entry: ${name}`);
    if (entry?.kind === "directory")
      for (const file of Object.keys(entry.files)) safeRelative(file);
  }
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
  const manifestPath = `${output}.owned.json`;
  const manifest = await readManifest(manifestPath);
  const foreignEntries: string[] = [];
  for (const entry of await NodeFSP.readdir(output)) {
    // An owned name is ours when the profile has it or an earlier build wrote it.
    const ours = entry in owned && (owned[entry] !== null || entry in manifest);
    if (
      entry !== skillParts[0] &&
      !ours &&
      !(await NodeFSP.lstat(NodePath.join(output, entry))).isSymbolicLink()
    )
      foreignEntries.push(entry);
  }
  const ownedChanges = await writeOwned(output, owned, manifest, manifestPath);
  const excluded = new Set([skillParts[0], ...(input.privateEntries ?? []), ...Object.keys(owned)]);
  for (const name of input.privateEntries ?? []) {
    safeEntry(name);
    const privatePath = NodePath.join(output, name);
    if ((await NodeFSP.lstat(privatePath).catch(() => undefined))?.isSymbolicLink())
      await NodeFSP.rm(privatePath);
  }
  for (const entry of await NodeFSP.readdir(home)) {
    if (!excluded.has(entry) && !foreignEntries.includes(entry))
      await link(NodePath.join(home, entry), NodePath.join(output, entry));
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
      if (entry !== skillParts[index + 1] && !input.privateEntries?.includes(skillParts[0]!))
        await link(NodePath.join(sourceParent, entry), NodePath.join(outputParent, entry));
    }
  }
  const skillsDir = NodePath.join(output, ...skillParts);
  const existing = await NodeFSP.lstat(skillsDir).catch(() => undefined);
  if (existing?.isSymbolicLink()) await NodeFSP.rm(skillsDir);
  await NodeFSP.mkdir(skillsDir, { recursive: true });
  const enabled = new Set(input.skills.map((skill) => skill.name));
  const foreignSkills = new Set<string>();
  for (const entry of await NodeFSP.readdir(skillsDir)) {
    const path = NodePath.join(skillsDir, entry);
    if (!(await NodeFSP.lstat(path)).isSymbolicLink()) {
      foreignEntries.push(entry);
      foreignSkills.add(entry);
      continue;
    }
    if (!enabled.has(entry)) {
      await NodeFSP.rm(path);
    }
  }
  for (const skill of input.skills)
    if (!foreignSkills.has(skill.name))
      await link(skill.targetPath, NodePath.join(skillsDir, skill.name));
  return { homePath: output, foreignEntries, ownedChanges };
}

interface ManifestEntry {
  readonly hash: string;
  readonly keys?: Readonly<Record<string, string>>;
}
type Manifest = Record<string, ManifestEntry>;
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

async function readManifest(path: string): Promise<Manifest> {
  const text = await NodeFSP.readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? { ...(value as Manifest) } : {};
  } catch {
    return {};
  }
}

function topLevelKeys(name: string, contents: string): Record<string, string> | undefined {
  try {
    const value: unknown = name.endsWith(".json")
      ? JSON.parse(contents)
      : name.endsWith(".toml")
        ? parseToml(contents)
        : undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, digest(JSON.stringify(item) ?? "")]),
    );
  } catch {
    return undefined;
  }
}

function entryOf(name: string, contents: string): ManifestEntry {
  const keys = topLevelKeys(name, contents);
  return keys ? { hash: digest(contents), keys } : { hash: digest(contents) };
}
const directoryHash = (files: ReadonlyArray<readonly [string, string]>) =>
  digest(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b))));

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await NodeFSP.readdir(NodePath.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)));
    else files.push(relative);
  }
  return files;
}

async function currentEntry(name: string, path: string): Promise<ManifestEntry | undefined> {
  const info = await NodeFSP.lstat(path).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return undefined;
  if (info.isDirectory()) {
    const files = await listFiles(path);
    return {
      hash: directoryHash(
        await Promise.all(
          files.map(
            async (file) =>
              [file, await NodeFSP.readFile(NodePath.join(path, file), "utf8")] as const,
          ),
        ),
      ),
    };
  }
  return entryOf(name, await NodeFSP.readFile(path, "utf8"));
}

function desiredEntry(name: string, entry: OwnedEntry): ManifestEntry {
  if (entry.kind === "file") return entryOf(name, entry.contents);
  return {
    hash: directoryHash(
      Object.entries(entry.files).map(
        ([file, contents]) => [file.replaceAll("\\", "/"), contents] as const,
      ),
    ),
  };
}

async function writeFileAtomic(path: string, contents: string) {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    const file = await NodeFSP.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

async function replaceDirectory(path: string, files: Readonly<Record<string, string>>) {
  const staging = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  const retired = `${path}.${NodeCrypto.randomUUID()}.old`;
  try {
    await NodeFSP.mkdir(staging);
    for (const [file, contents] of Object.entries(files))
      await writeFileAtomic(NodePath.join(staging, ...file.split(/[\\/]/)), contents);
    if (await NodeFSP.lstat(path).catch(() => undefined)) await NodeFSP.rename(path, retired);
    await NodeFSP.rename(staging, path);
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
    await NodeFSP.rm(retired, { recursive: true, force: true });
  }
}

function changedKeys(previous: ManifestEntry, current: ManifestEntry) {
  if (!previous.keys || !current.keys) return undefined;
  const before = previous.keys;
  const after = current.keys;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key])
    .sort();
}

async function writeOwned(
  output: string,
  owned: OwnedEntries,
  manifest: Manifest,
  manifestPath: string,
): Promise<OwnedChange[]> {
  const changes: OwnedChange[] = [];
  const next: Manifest = {};
  for (const [name, entry] of Object.entries(owned)) {
    const path = NodePath.join(output, name);
    const info = await NodeFSP.lstat(path).catch(() => undefined);
    if (info?.isSymbolicLink()) await NodeFSP.rm(path);
    const previous = manifest[name];
    const current = info?.isSymbolicLink() ? undefined : await currentEntry(name, path);
    if (previous && current && previous.hash !== current.hash) {
      const keys = changedKeys(previous, current);
      changes.push(keys ? { entry: name, keys } : { entry: name });
    }
    if (entry === null) {
      // A real entry this builder never wrote belongs to the program; keep it.
      if (current && previous) await NodeFSP.rm(path, { recursive: true, force: true });
      continue;
    }
    const desired = desiredEntry(name, entry);
    if (current?.hash !== desired.hash) {
      if (current && !previous) changes.push({ entry: name });
      if (entry.kind === "file") {
        if (current && info?.isDirectory()) await NodeFSP.rm(path, { recursive: true });
        await writeFileAtomic(path, entry.contents);
      } else {
        if (current && info?.isFile()) await NodeFSP.rm(path);
        await replaceDirectory(path, entry.files);
      }
    }
    next[name] = desired;
  }
  await writeFileAtomic(manifestPath, JSON.stringify(next, null, 2) + "\n");
  return changes;
}

/**
 * Records the current contents of owned entries as the new baseline after a provider edits its
 * own copy (for example Codex `config/batchWrite`), so that edit is not reported as a session write.
 */
export async function acceptOwnedEntries(homePath: string, names: readonly string[]) {
  const output = await NodeFSP.realpath(homePath);
  const manifestPath = `${output}.owned.json`;
  const manifest = await readManifest(manifestPath);
  for (const name of names) {
    safeEntry(name);
    const entry = await currentEntry(name, NodePath.join(output, name));
    if (entry) manifest[name] = entry;
    else delete manifest[name];
  }
  await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
