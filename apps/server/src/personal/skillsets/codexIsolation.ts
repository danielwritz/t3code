import type { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { withCodexAppServerClient } from "../../provider/CodexProvider.ts";
import { resolveCodexLaunchArgs } from "../../provider/codexLaunchArgs.ts";
import { codexProjectSkillPaths } from "./codexOrigins.ts";

interface CodexSkillInventoryEntry {
  readonly name: string;
  readonly path: string;
  readonly scope: string;
  readonly enabled: boolean;
  readonly pluginId?: string | null;
}
export interface CodexSkillInventory {
  readonly skills: readonly CodexSkillInventoryEntry[];
  readonly homeScopedCredentials: boolean;
  readonly preservedPaths?: readonly string[];
}
const decodeConfig = Schema.decodeUnknownEffect(
  Schema.Struct({ config: Schema.Record(Schema.String, Schema.Unknown) }),
);

export const discoverCodexSkillInventory = Effect.fn("SkillSets.discoverCodexInventory")(function* (
  settings: CodexSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const { client } = yield* withCodexAppServerClient({
    binaryPath: settings.binaryPath || "codex",
    homePath: settings.homePath,
    launchArgs: resolveCodexLaunchArgs(settings.launchArgs, environment),
    environment,
    cwd,
  });
  const config = yield* client.raw
    .request("config/read", { includeLayers: false, cwd })
    .pipe(Effect.flatMap(decodeConfig));
  const response = yield* client.request("skills/list", { cwds: [cwd], forceReload: true });
  const credentialStore = config.config["cli_auth_credentials_store"];
  const skills = response.data.flatMap((entry) => entry.skills);
  const configuredMarkers = config.config["project_root_markers"];
  const markers =
    Array.isArray(configuredMarkers) &&
    configuredMarkers.every((marker): marker is string => typeof marker === "string")
      ? configuredMarkers
      : [".git"];
  const preservedPaths = yield* codexProjectSkillPaths(cwd, markers).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "Could not inspect Codex project aliases; retaining potentially shared skills",
        {
          skills: skills.filter((skill) => skill.scope === "user").map((skill) => skill.name),
          cause,
        },
      ).pipe(Effect.as(skills.map((skill) => skill.path))),
    ),
  );
  return {
    skills,
    preservedPaths,
    homeScopedCredentials: credentialStore === "keyring" || credentialStore === "auto",
  };
});

export const codexIsolationOverrides = Effect.fn("SkillSets.codexIsolationOverrides")(function* (
  skills: readonly CodexSkillInventoryEntry[],
  selected: readonly { readonly targetPath: string }[],
  preservedPaths: readonly string[] = [],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonical = (file: string) =>
    fs.realPath(file).pipe(Effect.orElseSucceed(() => path.resolve(file)));
  const picked = new Set(
    yield* Effect.forEach(selected, (skill) => canonical(path.join(skill.targetPath, "SKILL.md"))),
  );
  const inventory = yield* Effect.forEach(skills, (skill) =>
    canonical(skill.path).pipe(Effect.map((file) => ({ ...skill, path: file }))),
  );
  const preserved = new Set(
    inventory
      .filter((skill) => skill.scope !== "user" || skill.pluginId)
      .map((skill) => skill.path),
  );
  for (const file of preservedPaths) preserved.add(yield* canonical(file));
  const rules = new Map<string, boolean>();
  for (const skill of inventory) {
    if (!skill.enabled) rules.set(skill.path, false);
    if (
      skill.scope === "user" &&
      !skill.pluginId &&
      !picked.has(skill.path) &&
      !preserved.has(skill.path)
    )
      rules.set(skill.path, false);
  }
  // Already-enabled selections need no override; long checkout paths otherwise overflow Windows shims.
  for (const file of picked) if (rules.has(file)) rules.set(file, true);
  const config = [...rules]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, enabled]) => `{path=${JSON.stringify(file)},enabled=${enabled}}`);
  // One TOML value is quoted as one CLI argument; user launch flags remain intact.
  const value = `skills.config=[${config.join(",")}]`;
  return `-c "${value.replace(/["\\$`]/g, "\\$&")}"`;
});
