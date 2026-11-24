// @effect-diagnostics nodeBuiltinImport:off -- Open read-only before any server resource can write this home.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { migrationManifest } from "../../persistence/Migrations.ts";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

export const NEWER_DATA_MESSAGE =
  "This T3 data was updated by a newer T3 Code. Update T3 Code (Daniel) before opening it.";
export const NEWER_DATA_MARKER = "T3_SKILL_SETS_GUARD=data-newer";
export const NEWER_DATA_EXIT_CODE = 79;

class NewerSkillSetHomeError extends Schema.TaggedError<NewerSkillSetHomeError>()(
  "NewerSkillSetHomeError",
  {},
) {
  override readonly [Runtime.errorExitCode] = NEWER_DATA_EXIT_CODE;
  override get message() {
    return NEWER_DATA_MESSAGE;
  }
}

class SkillSetHomeReadError extends Schema.TaggedError<SkillSetHomeReadError>()(
  "SkillSetHomeReadError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not check the T3 data migration history.";
  }
}
const isNewerSkillSetHomeError = Schema.is(NewerSkillSetHomeError);

export function assertCompatibleHome(dbPath: string): void {
  if (!NodeFS.existsSync(dbPath)) return;
  let temporary: string | undefined;
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    const walPath = `${dbPath}-wal`;
    if (NodeFS.existsSync(walPath) && NodeFS.statSync(walPath).size > 0) {
      // Immutable reads ignore WAL. Inspect a private copy after an unclean shutdown instead.
      temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-skill-sets-guard-"));
      const copy = NodePath.join(temporary, "state.sqlite");
      NodeFS.copyFileSync(dbPath, copy, NodeFS.constants.COPYFILE_FICLONE);
      NodeFS.copyFileSync(walPath, `${copy}-wal`);
      db = new NodeSqlite.DatabaseSync(copy, { readOnly: true });
    } else {
      db = new NodeSqlite.DatabaseSync(
        `${NodeURL.pathToFileURL(dbPath).href}?mode=ro&immutable=1`,
        {
          readOnly: true,
        },
      );
    }
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'effect_sql_migrations'").get())
      return;
    const known = new Map<number, string>(migrationManifest);
    const rows = db.prepare("SELECT migration_id, name FROM effect_sql_migrations").all();
    if (
      rows.some(
        (row) => typeof row.migration_id !== "number" || known.get(row.migration_id) !== row.name,
      )
    ) {
      throw new NewerSkillSetHomeError({});
    }
  } finally {
    db?.close();
    if (temporary) NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
}

export const guardHomeAtStartup = Effect.fn("SkillSetState.guardHomeAtStartup")((dbPath: string) =>
  Effect.try({
    try: () => assertCompatibleHome(dbPath),
    catch: (cause) =>
      isNewerSkillSetHomeError(cause) ? cause : new SkillSetHomeReadError({ cause }),
  }).pipe(
    Effect.tapError((error) =>
      isNewerSkillSetHomeError(error)
        ? Console.error(`${NEWER_DATA_MARKER}\n${NEWER_DATA_MESSAGE}`)
        : Effect.void,
    ),
  ),
);
