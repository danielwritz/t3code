// @effect-diagnostics nodeBuiltinImport:off -- Fork-owned files deliberately stay outside Nightly's persistence codecs.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Duration from "effect/Duration";
import type * as Scope from "effect/Scope";
import {
  skillSetSettingsFields,
  isSkillSetSettingsKey,
  type ServerSettings,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { fromLenientJson, fromJsonStringPretty } from "@t3tools/shared/schemaJson";

const Settings = Schema.Struct(skillSetSettingsFields);
const decode = Schema.decodeUnknownSync(Settings);
const encodeSkillSetSettings = Schema.encodeSync(Schema.fromJsonString(Settings));
const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(JsonObject);
const encodeJson = Schema.encodeEffect(
  fromJsonStringPretty(Schema.Record(Schema.String, Schema.Unknown)),
);
const parseLenient = Schema.decodeUnknownSync(fromLenientJson(Schema.Unknown));

export async function readSideFile(path: string): Promise<unknown | undefined> {
  try {
    return parseLenient(await NodeFSP.readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeSideFile(path: string, value: unknown): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    const file = await NodeFSP.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

export const skillSetStatePath = (settingsPath: string) =>
  NodePath.join(NodePath.dirname(settingsPath), "skill-sets", "state.json");

export const loadSkillSetSettings = Effect.fn("SkillSetState.loadSettings")(function* (
  settingsPath: string,
  settings: ServerSettings,
) {
  const path = skillSetStatePath(settingsPath);
  const saved = yield* Effect.promise(() => readSideFile(path));
  const values = decode(saved ?? settings);
  if (saved === undefined) yield* Effect.promise(() => writeSideFile(path, values));
  return { ...settings, ...values };
});

export const saveSkillSetSettings = Effect.fn("SkillSetState.saveSettings")(function* (
  settingsPath: string,
  settings: ServerSettings,
  encoded: string,
) {
  yield* Effect.promise(() => writeSideFile(skillSetStatePath(settingsPath), decode(settings)));
  const ordinary = { ...(yield* decodeJson(encoded)) };
  for (const key of Object.keys(ordinary)) if (isSkillSetSettingsKey(key)) delete ordinary[key];
  // Leave the old shape untouched for rollback; it is never authoritative after the first import.
  const legacy = yield* Effect.promise(() => readSideFile(settingsPath));
  if (legacy && typeof legacy === "object") {
    for (const [key, value] of Object.entries(legacy)) {
      if (isSkillSetSettingsKey(key)) ordinary[key] = value;
    }
  }
  return yield* encodeJson(ordinary);
});

export const reloadChanges = Effect.fn("SkillSetState.reloadChangedSettings")(function* (
  current: Effect.Effect<ServerSettings, ServerSettingsError>,
  reload: Effect.Effect<{ readonly settings: ServerSettings }, ServerSettingsError>,
  emit: (settings: ServerSettings) => Effect.Effect<void>,
) {
  const previous = yield* current;
  const next = yield* reload;
  if (encodeSkillSetSettings(previous) !== encodeSkillSetSettings(next.settings))
    yield* emit(next.settings);
});

export const startSkillSetSettingsWatch = Effect.fn("SkillSetState.startSettingsWatch")(function* <
  E,
>(events: Stream.Stream<unknown, E>, reload: Effect.Effect<void>, scope: Scope.Scope) {
  yield* events.pipe(
    Stream.debounce(Duration.millis(100)),
    Stream.runForEach(() => reload),
    Effect.ignoreCause({ log: true }),
    Effect.forkIn(scope),
  );
});
