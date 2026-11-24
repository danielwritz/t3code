import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { ProjectIconOverride } from "./project.ts";
import { agentProfileRpcs } from "./agentProfiles.ts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "./auth.ts";
export * from "./agentProfiles.ts";

export const SkillSetConfig = Schema.Struct({
  name: Schema.String,
  source: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("git"),
      url: Schema.String,
      branch: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({ kind: Schema.Literal("local"), path: Schema.String }),
  ]),
  enabled: Schema.Boolean,
  logo: Schema.optionalKey(
    Schema.Union([
      ProjectIconOverride,
      Schema.Struct({ kind: Schema.Literal("repo-image"), path: Schema.String }),
    ]),
  ),
  autoSync: Schema.Boolean,
  disabledSkills: Schema.Array(Schema.String),
  /** Agent profile overlay: item ids switched off (skills stay in `disabledSkills`). */
  disabledItems: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Machine-policy hook items switched on (they are off unless listed here or referenced). */
  enabledItems: Schema.optionalKey(Schema.Array(Schema.String)),
  ignoreProjectInstructions: Schema.optionalKey(Schema.Boolean),
});
export type SkillSetConfig = typeof SkillSetConfig.Type;
export const skillSetSettingsFields = {
  skillSetsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultSkillSetId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  skillSetSyncIntervalMinutes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(15)),
  ),
  skillSets: Schema.Record(Schema.String, SkillSetConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
};
export const skillSetPatchFields = {
  skillSetsEnabled: Schema.optionalKey(Schema.Boolean),
  defaultSkillSetId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  skillSetSyncIntervalMinutes: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
  skillSets: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(SkillSetConfig))),
};
export const skillSetThreadFields = {
  skillSetId: Schema.optionalKey(Schema.NullOr(Schema.String)),
};
export function skillSetPick(input: { readonly skillSetId?: string | null }) {
  return input.skillSetId === undefined ? {} : { skillSetId: input.skillSetId };
}
export const SkillSetSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  commandOnly: Schema.Boolean,
  targetPath: Schema.String,
});
export type SkillSetSkill = typeof SkillSetSkill.Type;
export const SkillSetStatus = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["synced", "syncing", "error", "local"]),
  ready: Schema.optionalKey(Schema.Boolean),
  commit: Schema.NullOr(Schema.String),
  commitDate: Schema.NullOr(Schema.String),
  lastChecked: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  skills: Schema.Array(SkillSetSkill),
});
export type SkillSetStatus = typeof SkillSetStatus.Type;
export const skillSetRpcs = [
  Rpc.make("skillSets.status", {
    payload: Schema.Struct({}),
    success: Schema.Array(SkillSetStatus),
  }),
  Rpc.make("skillSets.sync", {
    payload: Schema.Struct({ id: Schema.String }),
    success: Schema.Array(SkillSetStatus),
  }),
  Rpc.make("skillSets.subscribe", {
    payload: Schema.Struct({}),
    success: Schema.Array(SkillSetStatus),
    stream: true,
  }),
  ...agentProfileRpcs,
] as const;

/** Client scope guards for every fork RPC; spread into `CLIENT_GUARDED_RPC_SCOPES`. */
export const SKILL_SET_RPC_SCOPES = {
  "skillSets.status": AuthOrchestrationReadScope,
  "skillSets.subscribe": AuthOrchestrationReadScope,
  "skillSets.sync": AuthSettingsWriteScope,
  "agentProfiles.list": AuthOrchestrationReadScope,
  "agentProfiles.inventory": AuthOrchestrationReadScope,
  "agentProfiles.threadOptions": AuthOrchestrationReadScope,
  "agentProfiles.setItemEnabled": AuthSettingsWriteScope,
  "agentProfiles.setIgnoreProject": AuthSettingsWriteScope,
  "agentProfiles.createFromReferences": AuthSettingsWriteScope,
  "agentProfiles.setThreadIgnoreProject": AuthOrchestrationOperateScope,
} as const;
/** Trace aggregate labels for every fork RPC; spread into the server's `RPC_AGGREGATES`. */
export const SKILL_SET_RPC_AGGREGATES = {
  "skillSets.status": "skillSets",
  "skillSets.subscribe": "skillSets",
  "skillSets.sync": "skillSets",
  "agentProfiles.list": "agentProfiles",
  "agentProfiles.inventory": "agentProfiles",
  "agentProfiles.threadOptions": "agentProfiles",
  "agentProfiles.setItemEnabled": "agentProfiles",
  "agentProfiles.setIgnoreProject": "agentProfiles",
  "agentProfiles.createFromReferences": "agentProfiles",
  "agentProfiles.setThreadIgnoreProject": "agentProfiles",
} as const;

export function isSkillSetSettingsKey(key: string): boolean {
  return (
    key === "skillSets" ||
    key === "skillSetsEnabled" ||
    key === "defaultSkillSetId" ||
    key === "skillSetSyncIntervalMinutes"
  );
}

export function skillSetParentThreadId(thread: {
  readonly creationSource: string;
  readonly lineage: {
    readonly parentThreadId: import("./baseSchemas.ts").ThreadId | null;
    readonly relationshipToParent: string | null;
  };
}) {
  return thread.creationSource === "provider" && thread.lineage.relationshipToParent === "subagent"
    ? thread.lineage.parentThreadId
    : null;
}
