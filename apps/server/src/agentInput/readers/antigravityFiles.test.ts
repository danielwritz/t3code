// @effect-diagnostics nodeBuiltinImport:off -- the reader under test works on real files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { antigravitySessionKey } from "./antigravityFiles.ts";

const SESSION = "0310afee-1111-2222-3333-444455556666";

describe("antigravitySessionKey", () => {
  it("changes when the transcript or the conversation database changes, and only then", async () => {
    const profile = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agy-key-"));
    try {
      const logs = NodePath.join(
        profile,
        "antigravity-acp",
        "brain",
        SESSION,
        ".system_generated",
        "logs",
      );
      const conversations = NodePath.join(profile, "antigravity-acp", "conversations");
      await NodeFSP.mkdir(logs, { recursive: true });
      await NodeFSP.mkdir(conversations, { recursive: true });
      const transcript = NodePath.join(logs, "transcript_full.jsonl");
      const database = NodePath.join(conversations, `${SESSION}.db`);

      expect(await antigravitySessionKey(profile, SESSION)).toBeUndefined();
      await NodeFSP.writeFile(transcript, '{"step":1}\n');
      await NodeFSP.writeFile(database, "db");
      const first = await antigravitySessionKey(profile, SESSION);
      expect(first).toBeDefined();
      expect(await antigravitySessionKey(profile, SESSION)).toBe(first);

      await NodeFSP.appendFile(transcript, '{"step":2}\n');
      const second = await antigravitySessionKey(profile, SESSION);
      expect(second).not.toBe(first);

      // SQLite in WAL mode writes new rows to the -wal file first.
      await NodeFSP.writeFile(`${database}-wal`, "wal");
      expect(await antigravitySessionKey(profile, SESSION)).not.toBe(second);

      expect(await antigravitySessionKey(profile, "../other")).toBeUndefined();
    } finally {
      await NodeFSP.rm(profile, { recursive: true, force: true });
    }
  });
});
