import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // scope is "default" for the environment default or "project:<projectId>".
  yield* sql`
    CREATE TABLE IF NOT EXISTS instruction_profile_scopes (
      scope TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});
