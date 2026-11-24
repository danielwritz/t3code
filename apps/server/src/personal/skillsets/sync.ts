// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Pure Node filesystem/process modules are tested on native links and injected time.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { parse } from "yaml";
import type { SkillSetConfig, SkillSetSkill, SkillSetStatus } from "@t3tools/contracts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const key = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
interface SyncSettings {
  readonly skillSetsEnabled: boolean;
  readonly skillSetSyncIntervalMinutes: number;
  readonly skillSets: Readonly<Record<string, SkillSetConfig>>;
}
async function git(cwd: string, ...args: string[]) {
  const result = await exec("git", ["-c", "credential.interactive=false", ...args], {
    cwd,
    timeout: 30000,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
      GCM_INTERACTIVE: "never",
      GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=10",
    },
  });
  return result.stdout.trim();
}
async function scanSkills(root: string): Promise<SkillSetSkill[]> {
  if (!(await NodeFSP.stat(root)).isDirectory())
    throw new Error("Skill set source is not a directory");
  const folder = NodePath.join(root, "skills");
  const skills: SkillSetSkill[] = [];
  for (const name of await NodeFSP.readdir(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    const targetPath = await NodeFSP.realpath(NodePath.join(folder, name));
    if (!(await NodeFSP.stat(targetPath)).isDirectory()) continue;
    const text = await NodeFSP.readFile(NodePath.join(targetPath, "SKILL.md"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) continue;
    let data: unknown;
    try {
      data = parse(match[1]!);
    } catch {
      // Match the provider's accepted plain scalars containing ': ' without changing YAML blocks.
      const repaired = match[1]!.replace(
        /^([\w-]+:[ \t]*)([^\r\n]*)/gm,
        (line, prefix: string, value: string) => {
          const scalar = value.split(/[ \t]+#/)[0] ?? "";
          if (!/:[ \t]/.test(scalar) || /^(?:["'[\]{}|>&*!#%@`]|[-?:](?:[ \t]|$))/.test(scalar))
            return line;
          return `${prefix}${JSON.stringify(scalar)}${value.slice(scalar.length)}`;
        },
      );
      data = parse(repaired);
    }
    if (!data || typeof data !== "object") continue;
    const front = data as Record<string, unknown>;
    skills.push({
      name: typeof front.name === "string" ? front.name : name,
      description: typeof front.description === "string" ? front.description : "",
      commandOnly: front["disable-model-invocation"] === true,
      targetPath,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
/** Serialized per set; a failed fetch/fast-forward never replaces the last good inventory. */
export class SkillSetSync {
  private readonly values = new Map<string, SkillSetStatus>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly checked = new Map<string, number>();
  private readonly sources = new Map<string, string>();
  private readonly listeners = new Set<(statuses: readonly SkillSetStatus[]) => void>();
  readonly stateDir: string;
  private readonly settings: () => SyncSettings;
  private readonly now: () => number;
  constructor(stateDir: string, settings: () => SyncSettings, now: () => number = Date.now) {
    this.stateDir = stateDir;
    this.settings = settings;
    this.now = now;
  }
  statuses(): readonly SkillSetStatus[] {
    return [...this.values.values()].filter((status) => {
      const set = this.settings().skillSets[status.id];
      return set?.enabled && this.sources.get(status.id) === JSON.stringify(set.source);
    });
  }
  subscribe(listener: (statuses: readonly SkillSetStatus[]) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(status: SkillSetStatus) {
    this.values.set(status.id, status);
    for (const listener of this.listeners) listener(this.statuses());
  }
  checkout(id: string, config: SkillSetConfig) {
    return config.source.kind === "local"
      ? config.source.path
      : NodePath.join(
          this.stateDir,
          "skill-sets",
          "repos",
          key(id + JSON.stringify(config.source)),
        );
  }
  async tick() {
    const settings = this.settings();
    if (!settings.skillSetsEnabled) return;
    for (const id of this.values.keys())
      if (!settings.skillSets[id]?.enabled) {
        this.values.delete(id);
        this.checked.delete(id);
        for (const listener of this.listeners) listener(this.statuses());
      }
    await Promise.all(
      Object.entries(settings.skillSets)
        .filter(
          ([id, set]) =>
            set.enabled &&
            (!this.values.has(id) ||
              this.sources.get(id) !== JSON.stringify(set.source) ||
              (set.autoSync &&
                this.now() - (this.checked.get(id) ?? 0) >=
                  settings.skillSetSyncIntervalMinutes * 60000)),
        )
        .map(([id]) => this.syncNow(id)),
    );
  }
  async syncNow(id: string): Promise<void> {
    if (this.pending.has(id)) return this.pending.get(id)!;
    const config = this.settings().skillSets[id];
    if (!this.settings().skillSetsEnabled || !config?.enabled) return;
    const run = this.sync(id, config).finally(() => this.pending.delete(id));
    this.pending.set(id, run);
    return run;
  }
  private async sync(id: string, config: SkillSetConfig) {
    const fingerprint = JSON.stringify(config.source);
    const previous = this.sources.get(id) === fingerprint ? this.values.get(id) : undefined;
    this.sources.set(id, fingerprint);
    const base: SkillSetStatus = previous ?? {
      id,
      state: "syncing",
      ready: false,
      commit: null,
      commitDate: null,
      lastChecked: null,
      error: null,
      skills: [],
    };
    this.publish({ ...base, state: "syncing", error: null });
    try {
      const path = this.checkout(id, config);
      let commit: string | null = null;
      let commitDate: string | null = null;
      if (config.source.kind === "git") {
        await NodeFSP.mkdir(NodePath.join(this.stateDir, "skill-sets", "repos"), {
          recursive: true,
        });
        if (!(await NodeFSP.stat(NodePath.join(path, ".git")).catch(() => undefined))) {
          const staging = path + ".clone";
          await NodeFSP.rm(staging, { recursive: true, force: true });
          try {
            await git(this.stateDir, "clone", "--", config.source.url, staging);
            if (config.source.branch) await git(staging, "checkout", config.source.branch);
            await NodeFSP.rename(staging, path);
          } catch (error) {
            await NodeFSP.rm(staging, { recursive: true, force: true });
            throw error;
          }
        } else {
          await git(path, "fetch", "origin");
          await git(
            path,
            "merge",
            "--ff-only",
            config.source.branch ? `origin/${config.source.branch}` : "@{upstream}",
          );
        }
        commit = await git(path, "rev-parse", "HEAD");
        commitDate = await git(path, "show", "-s", "--format=%cI", "HEAD");
      }
      const skills = await scanSkills(path);
      this.publish({
        id,
        state: config.source.kind === "local" ? "local" : "synced",
        ready: true,
        commit,
        commitDate,
        lastChecked: new Date(this.now()).toISOString(),
        error: null,
        skills,
      });
    } catch (error) {
      this.publish({
        ...base,
        state: "error",
        lastChecked: new Date(this.now()).toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.checked.set(id, this.now());
    }
  }
}
