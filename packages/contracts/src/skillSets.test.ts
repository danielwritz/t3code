import { ThreadId } from "./baseSchemas.ts";
import { skillSetParentThreadId } from "./skillSets.ts";
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
