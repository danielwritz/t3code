// @effect-diagnostics nodeBuiltinImport:off -- Fork-owned side file next to the skill-set state.
import * as NodePath from "node:path";
import { readSideFile, writeSideFile } from "./state.ts";

export const threadOptionsPath = (settingsPath: string) =>
  NodePath.join(NodePath.dirname(settingsPath), "skill-sets", "thread-options.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Per-thread profile options (lead decision 4): `{ "<threadId>": { "ignoreProjectInstructions": bool } }`.
 * A thread without an entry follows its profile. Writes are serialized and atomic.
 */
export class ThreadProfileOptions {
  private values: Map<string, boolean> | undefined;
  private queue: Promise<void> = Promise.resolve();
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  private async load() {
    if (this.values) return this.values;
    const saved = await readSideFile(this.path);
    const values = new Map<string, boolean>();
    if (isRecord(saved))
      for (const [threadId, options] of Object.entries(saved))
        if (isRecord(options) && typeof options.ignoreProjectInstructions === "boolean")
          values.set(threadId, options.ignoreProjectInstructions);
    this.values ??= values;
    return this.values;
  }
  async ignoreProject(threadId: string): Promise<boolean | null> {
    await this.queue;
    return (await this.load()).get(threadId) ?? null;
  }
  setIgnoreProject(threadId: string, value: boolean | null): Promise<void> {
    const run = this.queue.then(async () => {
      const next = new Map(await this.load());
      if (value === null) next.delete(threadId);
      else next.set(threadId, value);
      await writeSideFile(
        this.path,
        Object.fromEntries(
          [...next].map(([id, ignore]) => [id, { ignoreProjectInstructions: ignore }]),
        ),
      );
      this.values = next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
