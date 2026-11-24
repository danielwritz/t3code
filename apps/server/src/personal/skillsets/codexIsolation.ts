import type { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { withCodexAppServerClient } from "../../provider/CodexProvider.ts";
import { resolveCodexLaunchArgs } from "../../provider/codexLaunchArgs.ts";
import { codexProjectDirectories, codexProjectSkillPaths } from "./codexOrigins.ts";
import type { CodexConfigEdit, CodexHookListing, CodexProjectInventory } from "./codexProfile.ts";

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
  /** `hooks/list` for the working directory: profile, project, plugin and machine-policy hooks. */
  readonly hooks?: readonly CodexHookListing[];
  /** `hooks.state` of the user config layer (trust rows). */
  readonly hooksState?: unknown;
  readonly project?: CodexProjectInventory;
  /** `plugins` of the user config layer. */
  readonly userPlugins?: unknown;
  /** The working directory up to its project root. */
  readonly projectDirectories?: readonly string[];
}
// Switched off one by one in the thread config; every other key the repo sets gets the user value back.
const PROJECT_KEYS_HANDLED = new Set(["mcp_servers", "hooks", "skills", "projects"]);
const decodeConfig = Schema.decodeUnknownEffect(
  Schema.Struct({
    config: Schema.Record(Schema.String, Schema.Unknown),
    layers: Schema.optionalKey(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            name: Schema.Struct({ type: Schema.String }),
            config: Schema.Unknown,
          }),
        ),
      ),
    ),
  }),
);
const decodeHooks = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        hooks: Schema.Array(
          Schema.Struct({
            key: Schema.String,
            source: Schema.String,
            sourcePath: Schema.String,
            currentHash: Schema.String,
            command: Schema.optionalKey(Schema.String),
            pluginId: Schema.optionalKey(Schema.NullOr(Schema.String)),
            enabled: Schema.Boolean,
            trustStatus: Schema.String,
          }),
        ),
      }),
    ),
  }),
);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
    .request("config/read", { includeLayers: true, cwd })
    .pipe(Effect.flatMap(decodeConfig));
  const response = yield* client.request("skills/list", { cwds: [cwd], forceReload: true });
  const hooks = yield* client.raw.request("hooks/list", { cwds: [cwd] }).pipe(
    Effect.flatMap(decodeHooks),
    Effect.map((value) => value.data.flatMap((entry) => entry.hooks)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Codex hooks/list failed; treating the profile as hook-free", cause).pipe(
        Effect.as([]),
      ),
    ),
  );
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
  const layers = config.layers ?? [];
  const userLayer = layers.find((layer) => layer.name.type === "user")?.config;
  const user = isRecord(userLayer) ? userLayer : {};
  const configOverrides: Record<string, unknown> = {};
  for (const layer of layers) {
    if (layer.name.type !== "project" || !isRecord(layer.config)) continue;
    for (const [key, value] of Object.entries(layer.config)) {
      if (key in configOverrides || PROJECT_KEYS_HANDLED.has(key)) continue;
      const fallback =
        key in user
          ? user[key]
          : typeof value === "string"
            ? ""
            : Array.isArray(value)
              ? []
              : undefined;
      if (fallback !== undefined) configOverrides[key] = fallback;
    }
  }
  return {
    skills,
    preservedPaths,
    homeScopedCredentials: credentialStore === "keyring" || credentialStore === "auto",
    hooks,
    hooksState: isRecord(user.hooks) ? user.hooks.state : undefined,
    userPlugins: user.plugins,
    projectDirectories: yield* codexProjectDirectories(cwd, markers).pipe(
      Effect.orElseSucceed(() => [cwd]),
    ),
    project: {
      configOverrides,
      repoSkillPaths: skills.filter((skill) => skill.scope === "repo").map((skill) => skill.path),
      projectMcpServers: [
        ...new Set(
          layers.flatMap((layer) =>
            layer.name.type === "project" &&
            isRecord(layer.config) &&
            isRecord(layer.config.mcp_servers)
              ? Object.keys(layer.config.mcp_servers)
              : [],
          ),
        ),
      ],
      projectHookKeys: hooks.filter((hook) => hook.source === "project").map((hook) => hook.key),
    },
  } satisfies CodexSkillInventory;
});

/** Codex edits its own copy, so T3 needs no TOML writer and keeps Codex's formatting. */
export const writeCodexConfig = Effect.fn("SkillSets.writeCodexConfig")(function* (
  settings: CodexSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  filePath: string,
  edits: readonly CodexConfigEdit[],
) {
  const { client } = yield* withCodexAppServerClient({
    binaryPath: settings.binaryPath || "codex",
    homePath: settings.homePath,
    launchArgs: resolveCodexLaunchArgs(settings.launchArgs, environment),
    environment,
    cwd,
  });
  yield* client.raw.request("config/batchWrite", { filePath, edits: [...edits] });
});

/** Disable rules for user skills outside the profile (the OS home's `~/.agents/skills`). */
export const codexSkillRules = Effect.fn("SkillSets.codexSkillRules")(function* (
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
  for (const file of picked) if (rules.has(file)) rules.set(file, true);
  return [...rules]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, enabled]) => ({ path: file, enabled }));
});
