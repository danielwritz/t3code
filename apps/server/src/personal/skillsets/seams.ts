// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Pure Node filesystem/process modules are tested on native links and injected time.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
export interface Seam {
  readonly file: string;
  readonly marker?: string;
  readonly generated?: boolean;
  readonly connects: string;
}
export async function checkSeams(root: string, entries: readonly Seam[]): Promise<void> {
  for (const entry of entries) {
    const name = `${entry.file}: ${entry.connects}`;
    const text = await NodeFSP.readFile(NodePath.join(root, entry.file), "utf8").catch(() => {
      throw new Error(`Missing skill-set seam file: ${name}`);
    });
    if (!entry.generated && (!entry.marker || !text.includes(entry.marker)))
      throw new Error(`Missing skill-set seam marker: ${name}`);
  }
}
