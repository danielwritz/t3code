import {
  InstructionProfile,
  InstructionProfileItemKind,
  type InstructionProfileItem,
  InstructionProfileItemEffect,
  ProjectId,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

export type InstructionProfilesRepositoryError = PersistenceSqlError | PersistenceDecodeError;

const ProfileRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  globalInstructions: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const ItemRow = Schema.Struct({
  profileId: Schema.String,
  kind: InstructionProfileItemKind,
  name: Schema.String,
  enabled: Schema.Number,
});
const ScopeRow = Schema.Struct({ scope: Schema.String, profileId: Schema.String });
const decodeProfile = Schema.decodeUnknownEffect(InstructionProfile);
const decodeProjectId = Schema.decodeUnknownEffect(ProjectId);
const encodeEffects = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(InstructionProfileItemEffect)),
);

const DEFAULT_SCOPE = "default";
const PROJECT_SCOPE_PREFIX = "project:";
/** `profile_id` of an application row for a launch without a profile. */
export const NO_PROFILE_ID = "";

export interface InstructionProfileScopes {
  readonly defaultProfileId: string | null;
  readonly projects: ReadonlyMap<ProjectId, string>;
}

/** Saved profiles, which thread, project or default picks one, and what each launch applied. */
export class InstructionProfilesRepository extends Context.Service<
  InstructionProfilesRepository,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<InstructionProfile>,
      InstructionProfilesRepositoryError
    >;
    readonly get: (
      id: string,
    ) => Effect.Effect<InstructionProfile | undefined, InstructionProfilesRepositoryError>;
    /** Creates the profile or replaces it and all its items. */
    readonly save: (input: {
      readonly id: string;
      readonly name: string;
      readonly description: string;
      readonly globalInstructions: string;
      readonly items: ReadonlyArray<InstructionProfileItem>;
      readonly now: string;
    }) => Effect.Effect<InstructionProfile, InstructionProfilesRepositoryError>;
    /** Also clears every thread, project and default choice that named it. */
    readonly remove: (id: string) => Effect.Effect<void, InstructionProfilesRepositoryError>;
    readonly getThreadChoice: (
      threadId: ThreadId,
    ) => Effect.Effect<string | undefined, InstructionProfilesRepositoryError>;
    /** Null clears the choice. */
    readonly setThreadChoice: (input: {
      readonly threadId: ThreadId;
      readonly profileId: string | null;
      readonly now: string;
    }) => Effect.Effect<void, InstructionProfilesRepositoryError>;
    readonly getScopes: Effect.Effect<InstructionProfileScopes, InstructionProfilesRepositoryError>;
    /** Whether any thread, project or default names a profile. */
    readonly hasAnyChoice: Effect.Effect<boolean, InstructionProfilesRepositoryError>;
    /** `projectId` null sets the environment default; `profileId` null clears it. */
    readonly setScope: (input: {
      readonly projectId: ProjectId | null;
      readonly profileId: string | null;
      readonly now: string;
    }) => Effect.Effect<void, InstructionProfilesRepositoryError>;
    readonly recordApplication: (input: {
      readonly threadId: ThreadId;
      readonly profileId: string;
      readonly profileName: string;
      readonly driver: ProviderDriverKind;
      readonly effects: ReadonlyArray<InstructionProfileItemEffect>;
      readonly now: string;
    }) => Effect.Effect<void, InstructionProfilesRepositoryError>;
    /** Writes a no-profile row only when the thread's latest row named a profile. */
    readonly recordNoProfile: (input: {
      readonly threadId: ThreadId;
      readonly driver: ProviderDriverKind;
      readonly now: string;
    }) => Effect.Effect<void, InstructionProfilesRepositoryError>;
  }
>()("t3/persistence/InstructionProfiles/InstructionProfilesRepository") {}

const toRepositoryError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(operation, cause)
    : new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const profileRows = SqlSchema.findAll({
    Request: Schema.NullOr(Schema.String),
    Result: ProfileRow,
    execute: (id) => sql`
      SELECT id, name, description, global_instructions AS "globalInstructions",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM instruction_profiles
      WHERE ${id === null ? sql`1 = 1` : sql`id = ${id}`}
      ORDER BY name COLLATE NOCASE, id
    `,
  });
  const itemRows = SqlSchema.findAll({
    Request: Schema.NullOr(Schema.String),
    Result: ItemRow,
    execute: (id) => sql`
      SELECT profile_id AS "profileId", kind, name, enabled
      FROM instruction_profile_items
      WHERE ${id === null ? sql`1 = 1` : sql`profile_id = ${id}`}
      ORDER BY profile_id, kind, name
    `,
  });
  const scopeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ScopeRow,
    execute: () => sql`
      SELECT scope, profile_id AS "profileId" FROM instruction_profile_scopes
    `,
  });

  const read = Effect.fnUntraced(function* (id: string | null) {
    const [profiles, items] = yield* Effect.all([profileRows(id), itemRows(id)]);
    return yield* Effect.forEach(profiles, (profile) =>
      decodeProfile({
        ...profile,
        items: items
          .filter((item) => item.profileId === profile.id)
          .map((item) => ({ kind: item.kind, name: item.name, enabled: item.enabled !== 0 })),
      }),
    );
  });

  return InstructionProfilesRepository.of({
    list: read(null).pipe(Effect.mapError(toRepositoryError("listInstructionProfiles"))),
    get: Effect.fn("InstructionProfilesRepository.get")(
      function* (id) {
        return (yield* read(id))[0];
      },
      Effect.mapError(toRepositoryError("getInstructionProfile")),
    ),
    save: Effect.fn("InstructionProfilesRepository.save")(
      function* (input) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO instruction_profiles
                (id, name, description, global_instructions, created_at, updated_at)
              VALUES (${input.id}, ${input.name}, ${input.description},
                ${input.globalInstructions}, ${input.now}, ${input.now})
              ON CONFLICT (id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                global_instructions = excluded.global_instructions,
                updated_at = excluded.updated_at
            `;
            yield* sql`DELETE FROM instruction_profile_items WHERE profile_id = ${input.id}`;
            for (const item of input.items) {
              yield* sql`
                INSERT INTO instruction_profile_items (profile_id, kind, name, enabled)
                VALUES (${input.id}, ${item.kind}, ${item.name}, ${item.enabled ? 1 : 0})
                ON CONFLICT (profile_id, kind, name) DO UPDATE SET enabled = excluded.enabled
              `;
            }
          }),
        );
        const saved = (yield* read(input.id))[0];
        if (saved === undefined) {
          return yield* new PersistenceSqlError({
            operation: "saveInstructionProfile",
            cause: "The saved profile could not be read back.",
          });
        }
        return saved;
      },
      Effect.mapError(toRepositoryError("saveInstructionProfile")),
    ),
    remove: Effect.fn("InstructionProfilesRepository.remove")(
      function* (id) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM instruction_profile_items WHERE profile_id = ${id}`;
            yield* sql`DELETE FROM instruction_profiles WHERE id = ${id}`;
            yield* sql`DELETE FROM thread_instruction_profiles WHERE profile_id = ${id}`;
            yield* sql`DELETE FROM instruction_profile_scopes WHERE profile_id = ${id}`;
          }),
        );
      },
      Effect.mapError(toRepositoryError("deleteInstructionProfile")),
    ),
    getThreadChoice: Effect.fn("InstructionProfilesRepository.getThreadChoice")(
      function* (threadId) {
        const rows = yield* sql<{ readonly profileId: string }>`
          SELECT profile_id AS "profileId" FROM thread_instruction_profiles
          WHERE thread_id = ${threadId}
        `;
        return rows[0]?.profileId;
      },
      Effect.mapError(toRepositoryError("getThreadInstructionProfile")),
    ),
    setThreadChoice: Effect.fn("InstructionProfilesRepository.setThreadChoice")(
      function* (input) {
        yield* input.profileId === null
          ? sql`DELETE FROM thread_instruction_profiles WHERE thread_id = ${input.threadId}`
          : sql`
              INSERT INTO thread_instruction_profiles (thread_id, profile_id, updated_at)
              VALUES (${input.threadId}, ${input.profileId}, ${input.now})
              ON CONFLICT (thread_id)
              DO UPDATE SET profile_id = excluded.profile_id, updated_at = excluded.updated_at
            `;
      },
      Effect.mapError(toRepositoryError("setThreadInstructionProfile")),
    ),
    getScopes: Effect.gen(function* () {
      let defaultProfileId: string | null = null;
      const projects = new Map<ProjectId, string>();
      for (const row of yield* scopeRows(undefined)) {
        if (row.scope === DEFAULT_SCOPE) defaultProfileId = row.profileId;
        else if (row.scope.startsWith(PROJECT_SCOPE_PREFIX)) {
          projects.set(
            yield* decodeProjectId(row.scope.slice(PROJECT_SCOPE_PREFIX.length)),
            row.profileId,
          );
        }
      }
      return { defaultProfileId, projects } satisfies InstructionProfileScopes;
    }).pipe(Effect.mapError(toRepositoryError("readInstructionProfileScopes"))),
    hasAnyChoice: sql<{ readonly chosen: number }>`
      SELECT (EXISTS (SELECT 1 FROM thread_instruction_profiles)
        OR EXISTS (SELECT 1 FROM instruction_profile_scopes)) AS "chosen"
    `.pipe(
      Effect.map((rows) => rows[0]?.chosen === 1),
      Effect.mapError(toRepositoryError("readInstructionProfileChoices")),
    ),
    setScope: Effect.fn("InstructionProfilesRepository.setScope")(
      function* (input) {
        const scope =
          input.projectId === null ? DEFAULT_SCOPE : `${PROJECT_SCOPE_PREFIX}${input.projectId}`;
        yield* input.profileId === null
          ? sql`DELETE FROM instruction_profile_scopes WHERE scope = ${scope}`
          : sql`
              INSERT INTO instruction_profile_scopes (scope, profile_id, updated_at)
              VALUES (${scope}, ${input.profileId}, ${input.now})
              ON CONFLICT (scope)
              DO UPDATE SET profile_id = excluded.profile_id, updated_at = excluded.updated_at
            `;
      },
      Effect.mapError(toRepositoryError("setInstructionProfileScope")),
    ),
    recordApplication: Effect.fn("InstructionProfilesRepository.recordApplication")(
      function* (input) {
        const effectsJson = yield* encodeEffects(input.effects);
        yield* sql`
          INSERT INTO instruction_profile_applications
            (thread_id, profile_id, profile_name, driver, effects_json, applied_at)
          VALUES (${input.threadId}, ${input.profileId}, ${input.profileName}, ${input.driver},
            ${effectsJson}, ${input.now})
        `;
      },
      Effect.mapError(toRepositoryError("recordInstructionProfileApplication")),
    ),
    recordNoProfile: Effect.fn("InstructionProfilesRepository.recordNoProfile")(
      function* (input) {
        yield* sql`
          INSERT INTO instruction_profile_applications
            (thread_id, profile_id, profile_name, driver, effects_json, applied_at)
          SELECT ${input.threadId}, ${NO_PROFILE_ID}, '', ${input.driver}, '[]', ${input.now}
          WHERE (
            SELECT profile_id FROM instruction_profile_applications
            WHERE thread_id = ${input.threadId}
            ORDER BY id DESC
            LIMIT 1
          ) <> ${NO_PROFILE_ID}
        `;
      },
      Effect.mapError(toRepositoryError("recordNoInstructionProfile")),
    ),
  });
});

export const layer = Layer.effect(InstructionProfilesRepository, make);
