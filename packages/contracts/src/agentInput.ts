import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { InstructionProfileItemEffect } from "./instructionProfile.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/** What a piece of the agent's input is. */
export const AgentInputLayerKind = Schema.Literals([
  "system-prompt",
  /** Text T3 itself adds. */
  "host-instructions",
  /** CLAUDE.md, AGENTS.md, GEMINI.md, rules. */
  "instruction-file",
  "memory",
  "skills",
  "agents",
  "mcp-instructions",
  "tools",
  "hook-output",
  "environment",
  "profile",
  "user-prompt",
  "other",
]);
export type AgentInputLayerKind = typeof AgentInputLayerKind.Type;

/** Who wrote a piece of the agent's input. */
export const AgentInputOrigin = Schema.Literals([
  "harness",
  "t3",
  "user-file",
  "mcp-server",
  "hook",
  "profile",
  "user",
]);
export type AgentInputOrigin = typeof AgentInputOrigin.Type;

/**
 * How close the trace is to what the model received: `exact` is a rebuilt API request whose
 * digest was checked, `harness-record` the agent's own session record, `t3-recorded` only what T3
 * handed to the provider, `none` nothing readable.
 */
export const AgentInputFidelity = Schema.Literals([
  "exact",
  "harness-record",
  "t3-recorded",
  "none",
]);
export type AgentInputFidelity = typeof AgentInputFidelity.Type;

export const AgentInputLayer = Schema.Struct({
  /** Stable within one trace; pass it back to read the layer's text. */
  id: TrimmedNonEmptyString,
  kind: AgentInputLayerKind,
  origin: AgentInputOrigin,
  title: Schema.String,
  path: Schema.optional(Schema.String),
  role: Schema.optional(Schema.Literals(["system", "developer", "user"])),
  chars: NonNegativeInt,
  /** The first request the layer appeared in. */
  requestIndex: Schema.optional(NonNegativeInt),
  at: Schema.optional(IsoDateTime),
  /** The first 200 characters on one line. */
  preview: Schema.String,
});
export type AgentInputLayer = typeof AgentInputLayer.Type;

/**
 * `verified`: the rebuilt request matched the digest the harness stored. `unverified`: it did
 * not, or the harness stores no digest. `not-checked`: not rebuilt yet; reading its text checks it.
 */
export const AgentInputVerification = Schema.Literals(["verified", "unverified", "not-checked"]);
export type AgentInputVerification = typeof AgentInputVerification.Type;

export const AgentInputRequest = Schema.Struct({
  index: NonNegativeInt,
  at: Schema.optional(IsoDateTime),
  model: Schema.optional(Schema.String),
  systemChars: NonNegativeInt,
  toolCount: NonNegativeInt,
  toolChars: NonNegativeInt,
  messageCount: NonNegativeInt,
  /** Absent until the request is rebuilt. */
  messageChars: Schema.optional(NonNegativeInt),
  totalChars: Schema.optional(NonNegativeInt),
  verification: AgentInputVerification,
});
export type AgentInputRequest = typeof AgentInputRequest.Type;

export const InstructionProfileToggle = Schema.Literals([
  "globalInstructions",
  "skill",
  "agent",
  "mcpServer",
]);
export type InstructionProfileToggle = typeof InstructionProfileToggle.Type;

export const InstructionProfileEffect = Schema.Struct({
  toggle: InstructionProfileToggle,
  name: Schema.optional(Schema.String),
  state: Schema.Literals(["applied", "not-supported", "unchanged"]),
  detail: Schema.String,
});
export type InstructionProfileEffect = typeof InstructionProfileEffect.Type;

export const AgentInputProfileUse = Schema.Struct({
  profileId: TrimmedNonEmptyString,
  profileName: Schema.String,
  appliedAt: IsoDateTime,
  /** A short view of `applied`, kept for clients built before it. */
  effects: Schema.Array(InstructionProfileEffect),
  driver: Schema.optional(ProviderDriverKind),
  /** Each profile entry with the switch used, or why it was not applied. */
  applied: Schema.optional(Schema.Array(InstructionProfileItemEffect)),
});
export type AgentInputProfileUse = typeof AgentInputProfileUse.Type;

export const GetThreadAgentInputInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetThreadAgentInputInput = typeof GetThreadAgentInputInput.Type;

/** Metadata only; read a layer's or request's text with `getThreadAgentInputText`. */
export const ThreadAgentInput = Schema.Struct({
  threadId: ThreadId,
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  nativeSessionId: Schema.optional(Schema.String),
  fidelity: AgentInputFidelity,
  /** A short label for where the trace came from, such as "Claude Code transcript". */
  source: Schema.String,
  layers: Schema.Array(AgentInputLayer),
  requests: Schema.Array(AgentInputRequest),
  profile: Schema.optional(AgentInputProfileUse),
  /** Plain sentences about gaps in the trace. */
  notes: Schema.Array(Schema.String),
});
export type ThreadAgentInput = typeof ThreadAgentInput.Type;

export const AgentInputRequestPart = Schema.Literals(["system", "tools", "messages"]);
export type AgentInputRequestPart = typeof AgentInputRequestPart.Type;

export const AgentInputTextTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("layer"), layerId: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("request"),
    index: NonNegativeInt,
    part: AgentInputRequestPart,
  }),
]);
export type AgentInputTextTarget = typeof AgentInputTextTarget.Type;

export const GetThreadAgentInputTextInput = Schema.Struct({
  threadId: ThreadId,
  target: AgentInputTextTarget,
});
export type GetThreadAgentInputTextInput = typeof GetThreadAgentInputTextInput.Type;

export const AGENT_INPUT_TEXT_MAX_CHARS = 256 * 1024;

export const AgentInputText = Schema.Struct({
  /** At most `AGENT_INPUT_TEXT_MAX_CHARS`; tools and messages are pretty-printed JSON. */
  text: Schema.String,
  /** The full length before truncation. */
  chars: NonNegativeInt,
  truncated: Schema.Boolean,
  /** For a request part: whether the rebuilt request matched its digest. */
  verification: Schema.optional(AgentInputVerification),
});
export type AgentInputText = typeof AgentInputText.Type;

export class AgentInputNotFoundError extends Schema.TaggedError<AgentInputNotFoundError>()(
  "AgentInputNotFoundError",
  {
    threadId: ThreadId,
    missing: Schema.Literals(["thread", "layer", "request"]),
  },
) {
  override get message(): string {
    return this.missing === "thread"
      ? "The thread does not exist."
      : `The agent input trace has no such ${this.missing}.`;
  }
}

export class AgentInputReadError extends Schema.TaggedError<AgentInputReadError>()(
  "AgentInputReadError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed to read the agent input trace.";
  }
}

export const AgentInputError = Schema.Union([AgentInputNotFoundError, AgentInputReadError]);
export type AgentInputError = typeof AgentInputError.Type;
