import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The same system text repeats across threads, so trace text is stored once per hash.
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_input_blobs (
      sha256 TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      chars INTEGER NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_input_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      kind TEXT NOT NULL,
      origin TEXT NOT NULL,
      title TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_input_records_thread
    ON agent_input_records(thread_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS instruction_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      global_instructions TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS instruction_profile_items (
      profile_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      PRIMARY KEY (profile_id, kind, name)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_instruction_profiles (
      thread_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS instruction_profile_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      profile_name TEXT NOT NULL,
      driver TEXT NOT NULL,
      effects_json TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_instruction_profile_applications_thread
    ON instruction_profile_applications(thread_id)
  `;
});
