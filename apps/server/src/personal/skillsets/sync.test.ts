/* oxlint-disable t3code/no-global-process-runtime -- Native filesystem module and tests must choose junction semantics before any provider runtime exists. */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Pure Node filesystem/process modules are tested on native links and injected time.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { SkillSetSync } from "./sync.ts";
it("clones, pulls, preserves last good checkout on failure, and honours interval", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sets-sync-"));
  const repo = NodePath.join(root, "repo");
  const bare = NodePath.join(root, "remote.git");
  await NodeFSP.mkdir(repo);
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await NodeFSP.mkdir(NodePath.join(repo, "skills", "alpha"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(repo, "skills", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: Alpha skill\ndisable-model-invocation: true\n---\n",
  );
  git("add", ".");
  git("commit", "-m", "initial");
  git("clone", "--bare", repo, bare);
  const settings = {
    skillSetsEnabled: true,
    skillSetSyncIntervalMinutes: 7,
    skillSets: {
      alpha: {
        name: "Alpha",
        source: { kind: "git" as const, url: bare },
        enabled: true,
        autoSync: true,
        disabledSkills: [],
      },
    },
  };
  let now = 0;
  const sync = new SkillSetSync(
    NodePath.join(root, "state"),
    () => settings,
    () => now,
  );
  await sync.tick();
  const first = sync.statuses()[0]!;
  expect(first.state).toBe("synced");
  expect(first.skills[0]?.commandOnly).toBe(true);
  await NodeFSP.writeFile(NodePath.join(repo, "new"), "new");
  git("add", ".");
  git("commit", "-m", "second");
  git("push", bare, "HEAD");
  now = 6 * 60000;
  await sync.tick();
  expect(sync.statuses()[0]?.commit).toBe(first.commit);
  now = 7 * 60000;
  await sync.tick();
  expect(sync.statuses()[0]?.commit).not.toBe(first.commit);
  const good = sync.statuses()[0]!.commit;
  await NodeFSP.rename(bare, bare + "-gone");
  await sync.syncNow("alpha");
  expect(sync.statuses()[0]?.state).toBe("error");
  expect(sync.statuses()[0]?.commit).toBe(good);
  expect(sync.statuses()[0]?.error).toBeTruthy();
  expect(sync.statuses()[0]?.skills).toHaveLength(1);
  const target = NodePath.join(root, "skill-target");
  const local = NodePath.join(root, "local");
  await NodeFSP.mkdir(target);
  await NodeFSP.mkdir(NodePath.join(local, "skills"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(target, "SKILL.md"),
    "---\nname: linked\ndescription: Linked skill\n---\n",
  );
  await NodeFSP.symlink(
    target,
    NodePath.join(local, "skills", "linked"),
    NodeOS.platform() === "win32" ? "junction" : "dir",
  );
  const localSync = new SkillSetSync(NodePath.join(root, "other"), () => ({
    ...settings,
    skillSets: {
      beta: { ...settings.skillSets.alpha, source: { kind: "local" as const, path: local } },
    },
  }));
  await localSync.tick();
  expect(localSync.statuses()[0]?.skills[0]?.name).toBe("linked");
});
it("reports a missing local source as not ready rather than an empty set", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "missing-set-"));
  const sync = new SkillSetSync(NodePath.join(root, "state"), () => ({
    skillSetsEnabled: true,
    skillSetSyncIntervalMinutes: 7,
    skillSets: {
      alpha: {
        name: "Alpha",
        source: { kind: "local", path: NodePath.join(root, "missing") },
        enabled: true,
        autoSync: false,
        disabledSkills: [],
      },
    },
  }));
  await sync.tick();
  expect(sync.statuses()[0]?.state).toBe("error");
  expect(sync.statuses()[0]?.ready).toBe(false);
  expect(sync.statuses()[0]?.error).toBeTruthy();
});
