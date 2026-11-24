import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

class CodexProjectSkillScanLimitError extends Schema.TaggedError<CodexProjectSkillScanLimitError>()(
  "CodexProjectSkillScanLimitError",
  {},
) {
  override get message() {
    return "Codex project skill scan exceeded native bounds.";
  }
}

/** The working directory and its parents up to the project root, as Codex finds it by marker. */
export const codexProjectDirectories = Effect.fn("SkillSets.codexProjectDirectories")(function* (
  cwd: string,
  markers: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ancestors: string[] = [];
  let directory = path.resolve(cwd);
  while (true) {
    ancestors.push(directory);
    for (const marker of markers)
      if (yield* fs.exists(path.join(directory, marker))) return ancestors;
    const parent = path.dirname(directory);
    if (markers.length === 0 || parent === directory) return ancestors.slice(0, 1);
    directory = parent;
  }
});

// Codex deduplicates canonical paths before returning scopes, hiding some project aliases.
export const codexProjectSkillPaths = Effect.fn("SkillSets.codexProjectSkillPaths")(function* (
  cwd: string,
  markers: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ancestors: string[] = [];
  let directory = path.resolve(cwd);
  let foundMarker = false;
  while (true) {
    ancestors.push(directory);
    if (markers.length === 0) break;
    let markerExists = false;
    for (const marker of markers) {
      if (yield* fs.exists(path.join(directory, marker))) {
        markerExists = true;
        break;
      }
    }
    if (markerExists) {
      foundMarker = true;
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const roots = (foundMarker ? ancestors : ancestors.slice(0, 1)).map((root) =>
    path.join(root, ".agents", "skills"),
  );
  const queue = roots.map((directory) => ({ directory, depth: 0 }));
  const seen = new Set<string>();
  const paths: string[] = [];
  let entries = 0;
  while (queue.length > 0 && seen.size < 2000 && entries < 20_000) {
    const next = queue.shift()!;
    if (!(yield* fs.exists(next.directory))) continue;
    const canonical = yield* fs.realPath(next.directory);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    for (const name of yield* fs.readDirectory(next.directory)) {
      if (++entries > 20_000) break;
      if (name.startsWith(".")) continue;
      const file = path.join(next.directory, name);
      const stat = yield* fs.stat(file).pipe(Effect.option);
      if (stat._tag === "None") continue;
      if (name === "SKILL.md" && stat.value.type === "File") paths.push(yield* fs.realPath(file));
      if (stat.value.type === "Directory" && next.depth < 5)
        queue.push({ directory: file, depth: next.depth + 1 });
    }
  }
  if (queue.length > 0 || entries > 20_000) return yield* new CodexProjectSkillScanLimitError({});
  return paths;
});
