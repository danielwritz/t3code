import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/** Item name that stands for every item of its kind. */
export const INSTRUCTION_PROFILE_ALL_ITEMS = "*";

export const InstructionProfileId = TrimmedNonEmptyString;
export type InstructionProfileId = typeof InstructionProfileId.Type;

export const InstructionProfileItemKind = Schema.Literals(["skill", "agent", "mcpServer"]);
export type InstructionProfileItemKind = typeof InstructionProfileItemKind.Type;

export const InstructionProfileItem = Schema.Struct({
  kind: InstructionProfileItemKind,
  /** `*` means every item of this kind. */
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type InstructionProfileItem = typeof InstructionProfileItem.Type;

/** What an agent receives, applied at launch without writing the provider's own files. */
export const InstructionProfile = Schema.Struct({
  id: InstructionProfileId,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  /** One text for every provider. */
  globalInstructions: Schema.String,
  items: Schema.Array(InstructionProfileItem),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type InstructionProfile = typeof InstructionProfile.Type;

export const InstructionProfileEffectKind = Schema.Literals([
  "global-instructions",
  "skill",
  "agent",
  "mcpServer",
]);
export type InstructionProfileEffectKind = typeof InstructionProfileEffectKind.Type;

/** What one profile entry did at launch for one driver. */
export const InstructionProfileItemEffect = Schema.Struct({
  kind: InstructionProfileEffectKind,
  name: Schema.optional(Schema.String),
  requested: Schema.Literals(["on", "off", "add"]),
  result: Schema.Literals(["applied", "not-supported", "skipped"]),
  /** A plain sentence naming the switch, such as "config skills.include_instructions=false". */
  how: Schema.String,
  reason: Schema.optional(Schema.String),
});
export type InstructionProfileItemEffect = typeof InstructionProfileItemEffect.Type;

export const InstructionProfileSource = Schema.Literals(["thread", "project", "default", "none"]);
export type InstructionProfileSource = typeof InstructionProfileSource.Type;

export const SaveInstructionProfileInput = Schema.Struct({
  /** Omit to create; give an id to replace that profile and all its items. */
  id: Schema.optional(InstructionProfileId),
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  globalInstructions: Schema.optional(Schema.String),
  items: Schema.Array(InstructionProfileItem),
});
export type SaveInstructionProfileInput = typeof SaveInstructionProfileInput.Type;

export const DeleteInstructionProfileInput = Schema.Struct({ id: InstructionProfileId });
export type DeleteInstructionProfileInput = typeof DeleteInstructionProfileInput.Type;

export const ListInstructionProfilesResult = Schema.Struct({
  profiles: Schema.Array(InstructionProfile),
});
export type ListInstructionProfilesResult = typeof ListInstructionProfilesResult.Type;

export const GetThreadInstructionProfileInput = Schema.Struct({ threadId: ThreadId });
export type GetThreadInstructionProfileInput = typeof GetThreadInstructionProfileInput.Type;

/** The thread's own choice, what it inherits, and the profile that wins. */
export const ThreadInstructionProfile = Schema.Struct({
  threadId: ThreadId,
  threadProfileId: Schema.NullOr(InstructionProfileId),
  projectProfileId: Schema.NullOr(InstructionProfileId),
  defaultProfileId: Schema.NullOr(InstructionProfileId),
  source: InstructionProfileSource,
  profile: Schema.optional(InstructionProfile),
});
export type ThreadInstructionProfile = typeof ThreadInstructionProfile.Type;

export const SetThreadInstructionProfileInput = Schema.Struct({
  threadId: ThreadId,
  /** Null clears the thread's choice, so it inherits again. */
  profileId: Schema.NullOr(InstructionProfileId),
});
export type SetThreadInstructionProfileInput = typeof SetThreadInstructionProfileInput.Type;

export const InstructionProfileDefaults = Schema.Struct({
  defaultProfileId: Schema.NullOr(InstructionProfileId),
  projects: Schema.Array(Schema.Struct({ projectId: ProjectId, profileId: InstructionProfileId })),
});
export type InstructionProfileDefaults = typeof InstructionProfileDefaults.Type;

export const SetDefaultInstructionProfileInput = Schema.Struct({
  profileId: Schema.NullOr(InstructionProfileId),
});
export type SetDefaultInstructionProfileInput = typeof SetDefaultInstructionProfileInput.Type;

export const SetProjectInstructionProfileInput = Schema.Struct({
  projectId: ProjectId,
  profileId: Schema.NullOr(InstructionProfileId),
});
export type SetProjectInstructionProfileInput = typeof SetProjectInstructionProfileInput.Type;

export const InstructionProfileSupportLevel = Schema.Literals(["yes", "partial", "no"]);
export type InstructionProfileSupportLevel = typeof InstructionProfileSupportLevel.Type;

export const InstructionProfileDriverSupport = Schema.Struct({
  /** `*` is the row for every driver not listed. */
  driver: Schema.Union([ProviderDriverKind, Schema.Literal("*")]),
  kinds: Schema.Array(
    Schema.Struct({
      kind: InstructionProfileEffectKind,
      support: InstructionProfileSupportLevel,
      how: Schema.String,
    }),
  ),
});
export type InstructionProfileDriverSupport = typeof InstructionProfileDriverSupport.Type;

export const InstructionProfileSupportResult = Schema.Struct({
  drivers: Schema.Array(InstructionProfileDriverSupport),
});
export type InstructionProfileSupportResult = typeof InstructionProfileSupportResult.Type;

export class InstructionProfileNotFoundError extends Schema.TaggedError<InstructionProfileNotFoundError>()(
  "InstructionProfileNotFoundError",
  {
    missing: Schema.Literals(["profile", "thread"]),
    id: Schema.String,
  },
) {
  override get message(): string {
    return this.missing === "profile"
      ? "The instruction profile does not exist."
      : "The thread does not exist.";
  }
}

export class InstructionProfileStoreError extends Schema.TaggedError<InstructionProfileStoreError>()(
  "InstructionProfileStoreError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Instruction profiles could not be ${this.operation}.`;
  }
}

export const InstructionProfileError = Schema.Union([
  InstructionProfileNotFoundError,
  InstructionProfileStoreError,
]);
export type InstructionProfileError = typeof InstructionProfileError.Type;
