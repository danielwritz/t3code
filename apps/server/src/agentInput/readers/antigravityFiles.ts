// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite and lstat read the native session files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  antigravityManagedPath,
  antigravityProfileRoot,
} from "../../provider/acp/AntigravityProfilePaths.ts";
import type { AntigravitySessionFiles } from "./antigravitySession.ts";

const NATIVE_SESSION_ID = /^[\w-]+$/;

function lastGeneration(databasePath: string): Uint8Array | undefined {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 100");
    const hasTable =
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata'")
        .get() !== undefined;
    if (!hasTable) return undefined;
    const data = database
      .prepare("SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1")
      .get()?.data;
    return data instanceof Uint8Array ? data : undefined;
  } finally {
    database.close();
  }
}

/**
 * Changes whenever the files `loadAntigravitySessionFiles` reads could have changed: the
 * transcript and the conversation database with its WAL. Undefined when there is no transcript.
 */
export async function antigravitySessionKey(
  profileDirectory: string,
  sessionId: string,
): Promise<string | undefined> {
  if (!NATIVE_SESSION_ID.test(sessionId)) return undefined;
  const root = await antigravityProfileRoot(profileDirectory);
  if (root === undefined) return undefined;
  const transcript = await antigravityManagedPath(
    root,
    ["antigravity-acp", "brain", sessionId, ".system_generated", "logs", "transcript_full.jsonl"],
    "file",
  );
  if (transcript === undefined) return undefined;
  const database = NodePath.join(root, "antigravity-acp", "conversations", `${sessionId}.db`);
  const stamp = (info: { size: number; mtimeMs: number } | undefined) =>
    info === undefined ? "-" : `${info.size}:${info.mtimeMs}`;
  const [databaseInfo, walInfo] = await Promise.all([
    NodeFSP.lstat(database).catch(() => undefined),
    NodeFSP.lstat(`${database}-wal`).catch(() => undefined),
  ]);
  return [transcript.path, stamp(transcript.info), stamp(databaseInfo), stamp(walInfo)].join("\0");
}

/**
 * Reads one session's own files below the Antigravity profile. Like the turn-outcome reader it
 * refuses links, which could point at another session's records. Undefined when no transcript.
 */
export async function loadAntigravitySessionFiles(
  profileDirectory: string,
  sessionId: string,
): Promise<AntigravitySessionFiles | undefined> {
  if (!NATIVE_SESSION_ID.test(sessionId)) return undefined;
  const root = await antigravityProfileRoot(profileDirectory);
  if (root === undefined) return undefined;
  const brain = ["antigravity-acp", "brain", sessionId];
  const transcript = await antigravityManagedPath(
    root,
    [...brain, ".system_generated", "logs", "transcript_full.jsonl"],
    "file",
  );
  if (transcript === undefined) return undefined;
  const transcriptText = await NodeFSP.readFile(transcript.path, "utf8");

  const mcpTools: Array<{ server: string; name: string; json: string }> = [];
  const mcp = await antigravityManagedPath(root, [...brain, "mcp"], "directory");
  if (mcp !== undefined) {
    for (const server of (await NodeFSP.readdir(mcp.path)).toSorted()) {
      const serverDirectory = await antigravityManagedPath(
        root,
        [...brain, "mcp", server],
        "directory",
      );
      if (serverDirectory === undefined) continue;
      for (const file of (await NodeFSP.readdir(serverDirectory.path)).toSorted()) {
        if (!file.endsWith(".json")) continue;
        const tool = await antigravityManagedPath(root, [...brain, "mcp", server, file], "file");
        if (tool === undefined) continue;
        mcpTools.push({
          server,
          name: NodePath.basename(file, ".json"),
          json: await NodeFSP.readFile(tool.path, "utf8"),
        });
      }
    }
  }

  const database = await antigravityManagedPath(
    root,
    ["antigravity-acp", "conversations", `${sessionId}.db`],
    "file",
  );
  let generation: Uint8Array | undefined;
  if (database !== undefined) {
    try {
      generation = lastGeneration(database.path);
    } catch {
      generation = undefined;
    }
  }
  return { transcriptLines: transcriptText.split("\n"), mcpTools, lastGeneration: generation };
}
