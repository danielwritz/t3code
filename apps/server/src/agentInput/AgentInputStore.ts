// @effect-diagnostics nodeBuiltinImport:off -- trace readers hash synchronously while parsing lines.
import * as NodeCrypto from "node:crypto";

import {
  AgentInputLayerKind,
  AgentInputOrigin,
  AgentInputProfileUse,
  InstructionProfileEffect,
  InstructionProfileItemEffect,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ProviderInputRecorder,
  type ProviderInputRecord,
} from "@t3tools/provider-core/server/ProviderInputRecorder";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import { NO_PROFILE_ID } from "../persistence/InstructionProfiles.ts";

const sha256Hex = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

const RecordRow = Schema.Struct({
  id: Schema.Number,
  runId: Schema.NullOr(Schema.String),
  kind: AgentInputLayerKind,
  origin: AgentInputOrigin,
  title: Schema.String,
  sha256: Schema.String,
  chars: Schema.Number,
  recordedAt: Schema.String,
});
export type AgentInputRecordRow = typeof RecordRow.Type;

const ProfileApplicationRow = Schema.Struct({
  profileId: Schema.String,
  profileName: Schema.String,
  driver: Schema.String,
  appliedAt: Schema.String,
  effectsJson: Schema.String,
});
// Rows written before the planner hold the short effect shape.
const decodeEffects = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Array(InstructionProfileItemEffect),
      Schema.Array(InstructionProfileEffect),
    ]),
  ),
);
const isItemEffect = Schema.is(InstructionProfileItemEffect);

const TOGGLE_OF = {
  "global-instructions": "globalInstructions",
  skill: "skill",
  agent: "agent",
  mcpServer: "mcpServer",
  host: "host",
} as const;

const shortEffect = (effect: InstructionProfileItemEffect): InstructionProfileEffect => ({
  toggle: TOGGLE_OF[effect.kind],
  ...(effect.name === undefined ? {} : { name: effect.name }),
  state: effect.result === "skipped" ? "unchanged" : effect.result,
  detail: effect.reason === undefined ? effect.how : `${effect.how}; ${effect.reason}`,
});
const decodeProfileUse = Schema.decodeUnknownEffect(AgentInputProfileUse);

type AgentInputStoreError = PersistenceSqlError | PersistenceDecodeError;

const toStoreError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(operation, cause)
    : new PersistenceSqlError({ operation, cause });

/** Text T3 handed to providers, stored once per hash, plus the profile applied to each thread. */
export class AgentInputStore extends Context.Service<
  AgentInputStore,
  {
    readonly record: (input: ProviderInputRecord) => Effect.Effect<void, AgentInputStoreError>;
    readonly listRecords: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<AgentInputRecordRow>, AgentInputStoreError>;
    readonly readText: (sha256: string) => Effect.Effect<string | undefined, AgentInputStoreError>;
    readonly latestProfileUse: (
      threadId: ThreadId,
    ) => Effect.Effect<AgentInputProfileUse | undefined, AgentInputStoreError>;
  }
>()("t3/agentInput/AgentInputStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: RecordRow,
    execute: (threadId) => sql`
      SELECT r.id AS "id", r.run_id AS "runId", r.kind AS "kind", r.origin AS "origin",
        r.title AS "title", r.sha256 AS "sha256", b.chars AS "chars",
        r.recorded_at AS "recordedAt"
      FROM agent_input_records r
      JOIN agent_input_blobs b ON b.sha256 = r.sha256
      WHERE r.thread_id = ${threadId}
      ORDER BY r.id
    `,
  });
  const latestApplication = SqlSchema.findAll({
    Request: Schema.String,
    Result: ProfileApplicationRow,
    execute: (threadId) => sql`
      SELECT profile_id AS "profileId", profile_name AS "profileName", driver,
        applied_at AS "appliedAt", effects_json AS "effectsJson"
      FROM instruction_profile_applications
      WHERE thread_id = ${threadId}
      ORDER BY id DESC
      LIMIT 1
    `,
  });

  return AgentInputStore.of({
    record: Effect.fn("AgentInputStore.record")(
      function* (input) {
        const sha256 = sha256Hex(input.text);
        const recordedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO agent_input_blobs (sha256, text, chars)
              VALUES (${sha256}, ${input.text}, ${input.text.length})
              ON CONFLICT (sha256) DO NOTHING
            `;
            yield* sql`
              INSERT INTO agent_input_records
                (thread_id, run_id, kind, origin, title, sha256, recorded_at)
              VALUES (${input.threadId}, ${input.runId ?? null}, ${input.kind}, ${input.origin},
                ${input.title}, ${sha256}, ${recordedAt})
            `;
          }),
        );
      },
      Effect.mapError((cause) => new PersistenceSqlError({ operation: "recordAgentInput", cause })),
    ),
    listRecords: Effect.fn("AgentInputStore.listRecords")(
      function* (threadId) {
        return yield* listRows(threadId);
      },
      Effect.mapError(toStoreError("listAgentInputRecords")),
    ),
    readText: Effect.fn("AgentInputStore.readText")(
      function* (sha256) {
        const rows = yield* sql<{ readonly text: string }>`
          SELECT text FROM agent_input_blobs WHERE sha256 = ${sha256}
        `;
        return rows[0]?.text;
      },
      Effect.mapError(
        (cause) => new PersistenceSqlError({ operation: "readAgentInputText", cause }),
      ),
    ),
    latestProfileUse: Effect.fn("AgentInputStore.latestProfileUse")(
      function* (threadId) {
        const row = (yield* latestApplication(threadId))[0];
        if (row === undefined || row.profileId === NO_PROFILE_ID) return undefined;
        const effects = yield* decodeEffects(row.effectsJson);
        const applied = effects.filter(isItemEffect);
        return yield* decodeProfileUse({
          profileId: row.profileId,
          profileName: row.profileName,
          appliedAt: row.appliedAt,
          driver: row.driver,
          effects: effects.map((effect) => (isItemEffect(effect) ? shortEffect(effect) : effect)),
          ...(applied.length === 0 && effects.length > 0 ? {} : { applied }),
        });
      },
      Effect.mapError(toStoreError("readInstructionProfileUse")),
    ),
  });
});

export const layer = Layer.effect(AgentInputStore, make);

/** Errors are logged without the text and never reach the turn. */
export const layerProviderInputRecorder = Layer.effect(
  ProviderInputRecorder,
  Effect.gen(function* () {
    const store = yield* AgentInputStore;
    return ProviderInputRecorder.of({
      record: Effect.fn("ProviderInputRecorder.record")(
        function* (input) {
          yield* store.record(input);
        },
        (effect, input) =>
          effect.pipe(
            Effect.catch((cause) =>
              Effect.logWarning("agent input record failed", {
                threadId: input.threadId,
                kind: input.kind,
                chars: input.text.length,
                // The SQL cause can carry the bound text.
                error: cause._tag,
              }),
            ),
          ),
      ),
    });
  }),
);

/** Removes trace and profile rows of deleted threads, and text no thread references. */
export const purgeDeletedThreadAgentInput = Effect.fn("AgentInput.purgeDeletedThreads")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      DELETE FROM agent_input_records WHERE thread_id IN (
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL
      )
    `;
    yield* sql`
      DELETE FROM agent_input_blobs WHERE sha256 NOT IN (SELECT sha256 FROM agent_input_records)
    `;
    yield* sql`
      DELETE FROM thread_instruction_profiles WHERE thread_id IN (
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL
      )
    `;
    yield* sql`
      DELETE FROM instruction_profile_applications WHERE thread_id IN (
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL
      )
    `;
  },
);
