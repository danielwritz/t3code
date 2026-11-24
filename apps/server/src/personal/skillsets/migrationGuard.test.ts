// @effect-diagnostics nodeBuiltinImport:off -- The guard must inspect a real, read-only SQLite connection.
import { expect, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { migrationManifest } from "../../persistence/Migrations.ts";
import {
  assertCompatibleHome,
  NEWER_DATA_MESSAGE,
  NEWER_DATA_MARKER,
  NEWER_DATA_EXIT_CODE,
} from "./migrationGuard.ts";

it("accepts equal and older ledgers, refuses unknown IDs and names without changing the database", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "migration-guard-"));
  const path = NodePath.join(dir, "statev2.sqlite");
  try {
    const db = new NodeSqlite.DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(
      "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    );
    const insert = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
    for (const [id, name] of migrationManifest.slice(0, -1)) insert.run(id, name);
    expect(() => assertCompatibleHome(path)).not.toThrow();
    const last = migrationManifest.at(-1)!;
    insert.run(...last);
    expect(() => assertCompatibleHome(path)).not.toThrow();
    const runGuard = () =>
      NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { guardHomeAtStartup } from ${JSON.stringify(new URL("./migrationGuard.ts", import.meta.url).href)}; import * as NodeRuntime from '@effect/platform-node/NodeRuntime'; guardHomeAtStartup(${JSON.stringify(path)}).pipe(NodeRuntime.runMain);`,
        ],
        { cwd: NodePath.resolve(import.meta.dirname, "../../.."), encoding: "utf8" },
      );
    const normal = runGuard();
    expect(normal.status, normal.stderr).toBe(0);
    expect(normal.stdout + normal.stderr).not.toContain(NEWER_DATA_MARKER);
    expect(normal.stdout + normal.stderr).not.toContain(NEWER_DATA_MESSAGE);
    insert.run(last[0] + 1, "FutureMigration");
    let before = await NodeFSP.readFile(path);
    expect(() => assertCompatibleHome(path)).toThrow(NEWER_DATA_MESSAGE);
    expect(await NodeFSP.readFile(path)).toEqual(before);
    const refused = runGuard();
    expect(refused.status, refused.stderr).toBe(NEWER_DATA_EXIT_CODE);
    expect(refused.stdout + refused.stderr).toContain(
      `${NEWER_DATA_MARKER}\n${NEWER_DATA_MESSAGE}`,
    );
    expect((refused.stdout + refused.stderr).split(NEWER_DATA_MESSAGE)).toHaveLength(2);
    db.prepare("DELETE FROM effect_sql_migrations WHERE migration_id = ?").run(last[0] + 1);
    db.prepare("UPDATE effect_sql_migrations SET name = 'UnknownName' WHERE migration_id = ?").run(
      last[0],
    );
    before = await NodeFSP.readFile(path);
    expect(() => assertCompatibleHome(path)).toThrow(NEWER_DATA_MESSAGE);
    expect(await NodeFSP.readFile(path)).toEqual(before);
    db.close();
    expect(() => assertCompatibleHome(path)).toThrow(NEWER_DATA_MESSAGE);
    expect(() => assertCompatibleHome(NodePath.join(dir, "missing.sqlite"))).not.toThrow();
    expect(await NodeFSP.readdir(dir)).toEqual(["statev2.sqlite"]);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
