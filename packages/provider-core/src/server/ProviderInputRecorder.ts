import type { AgentInputLayerKind, AgentInputOrigin, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export interface ProviderInputRecord {
  readonly threadId: ThreadId;
  readonly runId?: RunId | undefined;
  readonly kind: AgentInputLayerKind;
  readonly origin: AgentInputOrigin;
  readonly title: string;
  /** Prompt or instruction text only: never MCP headers, tokens or environment values. */
  readonly text: string;
}

/** Keeps the text T3 handed to a provider, for the thread's agent input trace. Never fails. */
export class ProviderInputRecorder extends Context.Service<
  ProviderInputRecorder,
  { readonly record: (input: ProviderInputRecord) => Effect.Effect<void> }
>()("@t3tools/provider-core/server/ProviderInputRecorder") {}

const NoOpProviderInputRecorder: ProviderInputRecorder["Service"] = {
  record: () => Effect.void,
};

/** Read once at construction: replay testkits and unit tests run without the recorder. */
export const currentProviderInputRecorder = Effect.serviceOption(ProviderInputRecorder).pipe(
  Effect.map(Option.getOrElse(() => NoOpProviderInputRecorder)),
);
