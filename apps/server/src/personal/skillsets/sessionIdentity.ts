import * as Effect from "effect/Effect";
import type { ProviderAdapterV2OpenSessionInput } from "@t3tools/provider-core/server/ProviderAdapter";

export interface SessionInputIdentity {
  readonly sessionInputIdentity?: (
    input: ProviderAdapterV2OpenSessionInput,
  ) => Effect.Effect<string | undefined>;
  readonly onAttachedSessionInput?: (
    owner: ProviderAdapterV2OpenSessionInput,
    attached: ProviderAdapterV2OpenSessionInput,
  ) => Effect.Effect<boolean>;
}

export function withSessionInputIdentity<T extends object>(
  runtime: T,
  sessionInputIdentity: NonNullable<SessionInputIdentity["sessionInputIdentity"]>,
  onAttachedSessionInput?: SessionInputIdentity["onAttachedSessionInput"],
) {
  return Object.assign(runtime, {
    sessionInputIdentity,
    ...(onAttachedSessionInput ? { onAttachedSessionInput } : {}),
  });
}

export function makeSessionInputIdentities() {
  const identities = new WeakMap<
    object,
    {
      readonly identity: string | undefined;
      readonly owner: ProviderAdapterV2OpenSessionInput;
      readonly warned: Set<string>;
    }
  >();
  const read = (runtime: object, input: ProviderAdapterV2OpenSessionInput) =>
    (runtime as SessionInputIdentity).sessionInputIdentity?.(input) ?? Effect.undefined;
  return {
    remember: (runtime: object, input: ProviderAdapterV2OpenSessionInput) =>
      read(runtime, input).pipe(
        Effect.tap((identity) =>
          Effect.sync(() => identities.set(runtime, { identity, owner: input, warned: new Set() })),
        ),
        Effect.asVoid,
      ),
    changed: Effect.fn("SessionInputIdentities.changed")(function* (
      runtime: object,
      input: ProviderAdapterV2OpenSessionInput,
      activeTurns = false,
    ) {
      const previous = identities.get(runtime);
      if (!previous) return false;
      if (input.threadId !== previous.owner.threadId) {
        const notify = (runtime as SessionInputIdentity).onAttachedSessionInput;
        if (
          notify &&
          !previous.warned.has(input.threadId) &&
          (yield* notify(previous.owner, input))
        )
          previous.warned.add(input.threadId);
        return false;
      }
      const identity = yield* read(runtime, input);
      if (identity === previous.identity) return false;
      if (activeTurns) {
        yield* Effect.logWarning(
          "Provider session input changed; reopening is deferred until active turns finish",
        );
        return false;
      }
      return true;
    }),
  };
}
