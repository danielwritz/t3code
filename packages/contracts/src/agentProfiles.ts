import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

/** Provider keys used in profile folders (`hooks/<provider>.json`), references and the wire. */
export const AgentProfileProvider = Schema.Literals(["claude", "codex", "antigravity"]);
export type AgentProfileProvider = typeof AgentProfileProvider.Type;
export const AGENT_PROFILE_PROVIDERS = ["claude", "codex", "antigravity"] as const;

const DRIVER_PROVIDERS: Readonly<Record<string, AgentProfileProvider>> = {
  claudeAgent: "claude",
  codex: "codex",
  antigravity: "antigravity",
};
/** The profile provider for a provider driver; undefined for drivers profiles do not support. */
export function agentProfileProviderForDriver(driver: string): AgentProfileProvider | undefined {
  return DRIVER_PROVIDERS[driver];
}

export const AgentProfileItemKind = Schema.Literals([
  "instructions",
  "skill",
  "plugin",
  "hook",
  "mcp",
]);
export type AgentProfileItemKind = typeof AgentProfileItemKind.Type;

/** What the detail view shows. Never carries MCP `env` or header values, only their names. */
export const AgentProfileItemDetail = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  event: Schema.optionalKey(Schema.String),
  matcher: Schema.optionalKey(Schema.String),
  commands: Schema.optionalKey(Schema.Array(Schema.String)),
  transport: Schema.optionalKey(Schema.Literals(["stdio", "http", "sse"])),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  url: Schema.optionalKey(Schema.String),
  envKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  headerKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  version: Schema.optionalKey(Schema.String),
});
export type AgentProfileItemDetail = typeof AgentProfileItemDetail.Type;

/** One row of the real setup on this machine. `id` is the reference a profile can point at. */
export const AgentProfileInventoryItem = Schema.Struct({
  id: Schema.String,
  provider: AgentProfileProvider,
  kind: AgentProfileItemKind,
  name: Schema.String,
  enabled: Schema.Boolean,
  /** `machine-policy`: installed for the whole machine; a profile can still switch it off. */
  source: Schema.Literals(["user", "machine-policy"]),
  detail: AgentProfileItemDetail,
});
export type AgentProfileInventoryItem = typeof AgentProfileInventoryItem.Type;

export const AgentProfileInventory = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      provider: AgentProfileProvider,
      home: Schema.String,
      items: Schema.Array(AgentProfileInventoryItem),
      errors: Schema.Array(Schema.String),
    }),
  ),
});
export type AgentProfileInventory = typeof AgentProfileInventory.Type;

/** One part of a profile. `provider` is null for parts every provider gets (skills, MCP, shared instructions). */
export const AgentProfileItem = Schema.Struct({
  id: Schema.String,
  kind: AgentProfileItemKind,
  provider: Schema.NullOr(AgentProfileProvider),
  name: Schema.String,
  enabled: Schema.Boolean,
  origin: Schema.Literals(["profile", "reference", "machine-policy"]),
  reference: Schema.optionalKey(Schema.String),
  missing: Schema.optionalKey(Schema.Boolean),
  detail: AgentProfileItemDetail,
});
export type AgentProfileItem = typeof AgentProfileItem.Type;

export const AgentProfileView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.NullOr(Schema.String),
  ignoreProjectInstructions: Schema.Boolean,
  items: Schema.Array(AgentProfileItem),
  errors: Schema.Array(Schema.String),
});
export type AgentProfileView = typeof AgentProfileView.Type;

export const AgentProfileThreadOptions = Schema.Struct({
  threadId: Schema.String,
  /** null: the thread follows its profile. */
  ignoreProjectInstructions: Schema.NullOr(Schema.Boolean),
});
export type AgentProfileThreadOptions = typeof AgentProfileThreadOptions.Type;

export class AgentProfileError extends Schema.TaggedError<AgentProfileError>()(
  "AgentProfileError",
  { message: Schema.String },
) {}

export const agentProfileRpcs = [
  Rpc.make("agentProfiles.list", {
    payload: Schema.Struct({}),
    success: Schema.Array(AgentProfileView),
    error: AgentProfileError,
  }),
  Rpc.make("agentProfiles.inventory", {
    payload: Schema.Struct({}),
    success: AgentProfileInventory,
    error: AgentProfileError,
  }),
  Rpc.make("agentProfiles.setItemEnabled", {
    payload: Schema.Struct({
      profileId: Schema.String,
      itemId: Schema.String,
      enabled: Schema.Boolean,
    }),
    success: AgentProfileView,
    error: AgentProfileError,
  }),
  Rpc.make("agentProfiles.setIgnoreProject", {
    payload: Schema.Struct({ profileId: Schema.String, ignore: Schema.Boolean }),
    success: AgentProfileView,
    error: AgentProfileError,
  }),
  Rpc.make("agentProfiles.threadOptions", {
    payload: Schema.Struct({ threadId: Schema.String }),
    success: AgentProfileThreadOptions,
    error: AgentProfileError,
  }),
  Rpc.make("agentProfiles.setThreadIgnoreProject", {
    payload: Schema.Struct({ threadId: Schema.String, ignore: Schema.NullOr(Schema.Boolean) }),
    success: AgentProfileThreadOptions,
    error: AgentProfileError,
  }),
  Rpc.make("agentProfiles.createFromReferences", {
    payload: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      references: Schema.Array(Schema.String),
    }),
    success: AgentProfileView,
    error: AgentProfileError,
  }),
] as const;
