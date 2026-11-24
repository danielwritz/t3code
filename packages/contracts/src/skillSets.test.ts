import { ThreadId } from "./baseSchemas.ts";
import {
  SKILL_SET_RPC_AGGREGATES,
  SKILL_SET_RPC_SCOPES,
  skillSetParentThreadId,
  skillSetRpcs,
} from "./skillSets.ts";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";
import { applyServerSettingsPatch } from "../../shared/src/serverSettings.ts";
const encode = Schema.encodeSync(ServerSettings);
const decode = Schema.decodeUnknownSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
it("round trips skill sets and removes one map entry with null", () => {
  const empty = decode({});
  expect(empty.skillSetsEnabled).toBe(false);
  expect(empty.skillSetSyncIntervalMinutes).toBe(15);
  const current = decode({
    ...encode(empty),
    skillSetsEnabled: true,
    defaultSkillSetId: "alpha",
    skillSetSyncIntervalMinutes: 7,
    skillSets: {
      alpha: {
        name: "Alpha",
        source: { kind: "local", path: "/neutral" },
        enabled: true,
        autoSync: true,
        disabledSkills: [],
      },
    },
  });
  expect(decode(encode(current))).toEqual(current);
  const patch = decodePatch({ skillSets: { alpha: null } });
  expect(applyServerSettingsPatch(current, patch).skillSets).toEqual({});
});

it("only provider-native children inherit the session owner's skill set", () => {
  const parent = ThreadId.make("parent");
  const thread = {
    creationSource: "provider",
    lineage: { parentThreadId: parent, relationshipToParent: "subagent" },
  } as const;
  expect(skillSetParentThreadId(thread)).toBe(parent);
  expect(skillSetParentThreadId({ ...thread, creationSource: "user" })).toBeNull();
  expect(
    skillSetParentThreadId({
      ...thread,
      lineage: { ...thread.lineage, relationshipToParent: "fork" },
    }),
  ).toBeNull();
});

it("keeps the agent profile overlay through a settings round trip", () => {
  const overlay = {
    name: "Alpha",
    source: { kind: "local", path: "/neutral" },
    enabled: true,
    autoSync: false,
    disabledSkills: ["beta"],
    disabledItems: ["mcp:docs"],
    enabledItems: ["policy:codex:hook:policy:hooks.json:PreToolUse:0"],
    ignoreProjectInstructions: true,
  };
  const settings = decode({ skillSets: { alpha: overlay } });
  expect(decode(encode(settings)).skillSets.alpha).toEqual(overlay);
});

it("guards and labels every fork RPC", () => {
  const tags = skillSetRpcs.map((rpc) => rpc._tag).sort();
  expect(Object.keys(SKILL_SET_RPC_SCOPES).sort()).toEqual(tags);
  expect(Object.keys(SKILL_SET_RPC_AGGREGATES).sort()).toEqual(tags);
});
