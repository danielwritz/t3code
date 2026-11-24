// @effect-diagnostics nodeBuiltinImport:off - Synchronous build configuration is read before the Effect runtime starts.
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";

const PersonalIdentity = Schema.Struct({
  productName: Schema.NonEmptyString,
  appId: Schema.NonEmptyString,
  packageName: Schema.NonEmptyString,
  userDataDirectory: Schema.NonEmptyString,
  scheme: Schema.NonEmptyString,
  iconSource: Schema.NonEmptyString,
  disableAutoUpdate: Schema.Literal(true),
  prepareServerCompileCache: Schema.optional(Schema.Boolean),
});

export type PersonalDesktopIdentity = typeof PersonalIdentity.Type;
const decodeIdentity = Schema.decodeSync(Schema.fromJsonString(PersonalIdentity));

export function readPersonalDesktopIdentity(
  configUrl = new URL("../../personal/desktop-identity.json", import.meta.url),
): PersonalDesktopIdentity | undefined {
  if (!NodeFS.existsSync(configUrl)) return undefined;
  return decodeIdentity(NodeFS.readFileSync(configUrl, "utf8"));
}

export const personalDesktopIdentity = readPersonalDesktopIdentity();
