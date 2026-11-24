// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- The switch file is a real file; time is injected.
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HOOK_SWITCH_TOKEN_ENV, HookSwitchStore } from "./hookSwitches.ts";

const off = (...guardIds: string[]) => ({
  machinePolicyHooksOff: guardIds.map((guardId, index) => ({
    id: `codex:hook:policy:hooks.json:PreToolUse:${index}`,
    file: "/policy/hooks.json",
    event: "PreToolUse",
    commands: [`node ${guardId}.mjs`],
    guardId,
  })),
});
async function store(now = () => Date.parse("2026-11-24T12:00:00.000Z")) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hook-switches-"));
  return new HookSwitchStore(NodePath.join(root, "skill-sets", "hook-switches.json"), now);
}
const read = async (switches: HookSwitchStore) =>
  JSON.parse(await NodeFSP.readFile(switches.path, "utf8").catch(() => "{}"));
const hash = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");

it("puts only a random token in the environment and its hash with the hook ids in the file", async () => {
  const switches = await store();
  const first = await switches.open(off("outside-post-guard", "outside-post-guard", "gate"), 41);
  const token = first.env[HOOK_SWITCH_TOKEN_ENV];
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(Object.keys(first.env)).toEqual([HOOK_SWITCH_TOKEN_ENV]);
  expect(await read(switches)).toEqual({
    [hash(token)]: {
      off: ["outside-post-guard", "gate"],
      pid: 41,
      createdAt: "2026-11-24T12:00:00.000Z",
    },
  });
  expect(await NodeFSP.readFile(switches.path, "utf8")).not.toContain(token);
  const second = await switches.open(off("gate"));
  expect(second.env[HOOK_SWITCH_TOKEN_ENV]).not.toBe(token);
  await second.setPid(77);
  expect((await read(switches))[hash(second.env[HOOK_SWITCH_TOKEN_ENV])].pid).toBe(77);
  await first.close();
  await first.close();
  expect(Object.keys(await read(switches))).toEqual([hash(second.env[HOOK_SWITCH_TOKEN_ENV])]);
});

it("writes no entry and blanks the variable when nothing is off", async () => {
  const switches = await store();
  const session = await switches.open(off());
  expect(session.env).toEqual({ [HOOK_SWITCH_TOKEN_ENV]: "" });
  await session.setPid(5);
  await session.close();
  expect(await read(switches)).toEqual({});
});

it("prunes entries older than a day", async () => {
  let now = Date.parse("2026-11-22T12:00:00.000Z");
  const switches = await store(() => now);
  const old = await switches.open(off("gate"));
  now = Date.parse("2026-11-24T11:00:00.000Z");
  const fresh = await switches.open(off("gate"));
  now = Date.parse("2026-11-24T12:00:00.000Z");
  await new HookSwitchStore(switches.path, () => now).pruneStale();
  expect(Object.keys(await read(switches))).toEqual([hash(fresh.env[HOOK_SWITCH_TOKEN_ENV])]);
  void old;
});
