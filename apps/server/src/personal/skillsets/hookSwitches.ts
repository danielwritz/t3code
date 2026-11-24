// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Fork-owned side file; time is injected for tests.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import type { ResolvedAgentProfile } from "./profile.ts";
import { readSideFile, writeSideFile } from "./state.ts";

/** The only value a profile session gets in its environment (lead decision 19). */
export const HOOK_SWITCH_TOKEN_ENV = "T3_PROFILE_HOOKS_TOKEN";
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export const hookSwitchesPath = (settingsPath: string) =>
  NodePath.join(NodePath.dirname(settingsPath), "skill-sets", "hook-switches.json");

interface HookSwitchEntry {
  readonly off: readonly string[];
  readonly pid: number | null;
  readonly createdAt: string;
}
type HookSwitches = Record<string, HookSwitchEntry>;

export interface HookSwitchSession {
  /** Merge into the provider process environment before it starts. */
  readonly env: Readonly<Record<typeof HOOK_SWITCH_TOKEN_ENV, string>>;
  /** Records the provider process id once it is known. */
  readonly setPid: (pid: number) => Promise<void>;
  /** Removes this session's entry; call when the provider session ends. Safe to call twice. */
  readonly close: () => Promise<void>;
}

const isEntry = (value: unknown): value is HookSwitchEntry =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as HookSwitchEntry).off) &&
  typeof (value as HookSwitchEntry).createdAt === "string";
const digest = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");

/**
 * `hook-switches.json`: `sha256(token) -> { off: [guard ids], pid, createdAt }`. A guard honours a
 * switch only when the hash of the token it sees is listed, so a settings file cannot forge one.
 */
export class HookSwitchStore {
  readonly path: string;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(path: string, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
  }
  private update(change: (switches: HookSwitches) => HookSwitches | undefined) {
    const run = this.queue.then(async () => {
      const saved = await readSideFile(this.path);
      const current: HookSwitches = {};
      if (typeof saved === "object" && saved !== null)
        for (const [key, value] of Object.entries(saved)) if (isEntry(value)) current[key] = value;
      const next = change(current);
      if (next) await writeSideFile(this.path, next);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  async open(
    profile: Pick<ResolvedAgentProfile, "machinePolicyHooksOff">,
    pid?: number,
  ): Promise<HookSwitchSession> {
    const off = [...new Set(profile.machinePolicyHooksOff.map((hook) => hook.guardId))].filter(
      (id) => id !== "",
    );
    if (off.length === 0)
      return {
        env: { [HOOK_SWITCH_TOKEN_ENV]: "" },
        setPid: async () => {},
        close: async () => {},
      };
    const token = NodeCrypto.randomBytes(32).toString("hex");
    const key = digest(token);
    const entry = { off, pid: pid ?? null, createdAt: new Date(this.now()).toISOString() };
    await this.update((switches) => ({ ...switches, [key]: entry }));
    return {
      env: { [HOOK_SWITCH_TOKEN_ENV]: token },
      setPid: (next) =>
        this.update((switches) =>
          switches[key] ? { ...switches, [key]: { ...switches[key], pid: next } } : undefined,
        ),
      close: () =>
        this.update((switches) => {
          if (!switches[key]) return undefined;
          const { [key]: _closed, ...rest } = switches;
          return rest;
        }),
    };
  }
  /** Drops entries older than a day (sessions that ended without closing). */
  pruneStale() {
    return this.update((switches) => {
      const cutoff = this.now() - STALE_AFTER_MS;
      const fresh = Object.entries(switches).filter(
        ([, entry]) => Date.parse(entry.createdAt) >= cutoff,
      );
      return fresh.length === Object.keys(switches).length ? undefined : Object.fromEntries(fresh);
    });
  }
}
