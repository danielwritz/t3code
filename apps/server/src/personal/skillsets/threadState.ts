// @effect-diagnostics nodeBuiltinImport:off -- This file owns the fork-only thread side file.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";
import {
  OrchestrationV2AppThreadJson as OrchestrationV2AppThreadJsonSchema,
  OrchestrationV2DomainEventJson,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { readSideFile, writeSideFile } from "./state.ts";

const Picks = Schema.Record(
  Schema.String,
  Schema.Array(
    Schema.Struct({
      eventId: Schema.NullOr(Schema.String),
      pick: Schema.NullOr(Schema.String),
    }),
  ),
);
const decodePicks = Schema.decodeUnknownSync(Picks);
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeThread = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema));
const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema),
);
const encodeEvent = Schema.encodeEffect(OrchestrationV2DomainEventJson);

export const makeThreadState = Effect.fn("SkillSetState.makeThreadState")(function* (
  sql: SqlClient.SqlClient,
  writer = false,
) {
  const databases = yield* sql<{ name: string; file: string }>`PRAGMA database_list`;
  const file = databases.find((entry) => entry.name === "main")?.file;
  const path = file
    ? NodePath.join(NodePath.dirname(file), "skill-sets", "threads.json")
    : undefined;
  let saved = path ? yield* Effect.promise(() => readSideFile(path)) : undefined;
  if (saved === undefined && path) {
    const rows = yield* sql<{
      thread_id: string;
      pick: string | null;
    }>`SELECT thread_id, json_extract(payload_json, '$.skillSetId') AS pick FROM orchestration_v2_projection_threads WHERE json_type(payload_json, '$.skillSetId') IN ('text', 'null')`;
    saved = Object.fromEntries(
      rows.map((row) => [row.thread_id, [{ eventId: null, pick: row.pick }]]),
    );
    if (writer) yield* Effect.promise(() => writeSideFile(path, saved));
  }
  let picks = decodePicks(saved ?? {});
  const eventIds = Object.values(picks).flatMap((entries) =>
    entries.flatMap((entry) => (entry.eventId === null ? [] : [entry.eventId])),
  );
  const committed =
    eventIds.length === 0
      ? []
      : yield* sql<{
          event_id: string;
        }>`SELECT event_id FROM orchestration_events WHERE event_id IN (SELECT value FROM json_each(${encodeIds(eventIds)}))`;
  const committedIds = new Set(committed.map((row) => row.event_id));
  const current = new Map(
    Object.entries(picks).flatMap(([id, entries]) => {
      const valid = entries.findLast(
        (entry) => entry.eventId === null || committedIds.has(entry.eventId),
      );
      return valid ? [[id, valid.pick] as const] : [];
    }),
  );
  if (writer && path && eventIds.length > 0) {
    picks = Object.fromEntries([...current].map(([id, pick]) => [id, [{ eventId: null, pick }]]));
    yield* Effect.promise(() => writeSideFile(path, picks));
  }
  const lock = yield* Semaphore.make(1);
  const transactionPicks = new WeakMap<object, Map<string, string | null>>();

  return {
    // Per-event and per-row codecs stay inside the enclosing store operation's span.
    encodeEvent: Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
      const encoded = yield* encodeEvent(event);
      if (!path || !event.type.startsWith("thread.") || !("skillSetId" in encoded.payload))
        return encoded;
      const pick = encoded.payload.skillSetId;
      if (typeof pick !== "string" && pick !== null) return encoded;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const entries = picks[event.threadId] ?? [];
          const ids = entries.flatMap((entry) => (entry.eventId === null ? [] : [entry.eventId]));
          const rows =
            ids.length === 0
              ? []
              : yield* sql<{
                  event_id: string;
                }>`SELECT event_id FROM orchestration_events WHERE event_id IN (SELECT value FROM json_each(${encodeIds(ids)}))`;
          const idsInDatabase = new Set(rows.map((row) => row.event_id));
          const previous = entries.findLast(
            (entry) => entry.eventId === null || idsInDatabase.has(entry.eventId),
          );
          if (previous?.pick === pick) return;
          const next = {
            ...picks,
            [event.threadId]: [...(previous ? [previous] : []), { eventId: event.id, pick }],
          };
          // Write before SQLite commits. On restart, an entry whose event rolled back is ignored.
          yield* Effect.promise(() => writeSideFile(path, next));
          picks = next;
        }),
      );
      yield* sql.afterCommit(
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (picks[event.threadId]?.at(-1)?.eventId !== event.id) return;
            const stable = { ...picks, [event.threadId]: [{ eventId: null, pick }] };
            yield* Effect.promise(() => writeSideFile(path, stable));
            picks = stable;
          }),
        ),
      );
      const { skillSetId: _pick, ...payload } = encoded.payload;
      return { ...encoded, payload } as typeof encoded;
    }),
    encodeThread: Effect.fnUntraced(function* (thread: OrchestrationV2AppThreadJsonSchema) {
      if (!path) return yield* encodeThread(thread);
      if (thread.skillSetId !== undefined) {
        const pick = thread.skillSetId;
        const transaction = yield* Effect.serviceOption(sql.transactionService);
        if (Option.isSome(transaction)) {
          const pending =
            transactionPicks.get(transaction.value) ?? new Map<string, string | null>();
          pending.set(thread.id, pick);
          transactionPicks.set(transaction.value, pending);
        }
        yield* sql.afterCommit(
          Effect.sync(() => {
            current.set(thread.id, pick);
          }),
        );
      }
      const { skillSetId: _pick, ...ordinary } = thread;
      return yield* encodeThread(ordinary);
    }),
    decodeThread: Effect.fnUntraced(function* (input: unknown) {
      const thread = yield* decodeThread(input);
      const transaction = yield* Effect.serviceOption(sql.transactionService);
      const pending = Option.isSome(transaction)
        ? transactionPicks.get(transaction.value)
        : undefined;
      const values = pending?.has(thread.id) ? pending : current;
      return values.has(thread.id) ? { ...thread, skillSetId: values.get(thread.id)! } : thread;
    }),
  };
});
