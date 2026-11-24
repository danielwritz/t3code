// @effect-diagnostics nodeBuiltinImport:off -- Builds a fake machine on disk for tests.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { defaultInventoryPaths } from "./inventory.ts";

export const write = async (path: string, contents: string) => {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, contents);
};
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\nbody\n`;
const hookFile = (command: string) =>
  JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
  });

/** A neutral fake user with one of every part per provider. */
export async function makeFakeMachine() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "inventory-"));
  const user = NodePath.join(root, "user");
  const paths = {
    ...defaultInventoryPaths(user, "linux", {}),
    claudePolicy: [NodePath.join(root, "policy", "claude", "managed-settings.d")],
    codexPolicy: [NodePath.join(root, "policy", "codex", "hooks.json")],
  };
  await write(NodePath.join(paths.claudeHome, "CLAUDE.md"), "claude rules");
  await write(NodePath.join(paths.claudeHome, "skills", "alpha", "SKILL.md"), skill("alpha"));
  await write(
    NodePath.join(paths.claudeHome, "settings.json"),
    JSON.stringify({
      model: "neutral",
      enabledPlugins: { "review@market": true, "design@market": false },
      hooks: JSON.parse(hookFile("node guard.mjs")).hooks,
    }),
  );
  await write(
    NodePath.join(paths.claudeHome, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "review@market": [{ installPath: "/plugins/review", version: "1.2.0" }] },
    }),
  );
  await write(
    paths.claudeJson,
    JSON.stringify({
      oauthAccount: { name: "not-read" },
      mcpServers: {
        calendar: {
          type: "stdio",
          command: "node",
          args: ["calendar.mjs"],
          env: { TOKEN: "s3cret" },
        },
        docs: {
          type: "http",
          url: "https://docs.example/mcp",
          headers: { Authorization: "s3cret" },
        },
      },
    }),
  );
  await write(NodePath.join(paths.claudePolicy[0]!, "policy.json"), hookFile("node policy.mjs"));
  await write(NodePath.join(paths.codexHome, "AGENTS.md"), "codex rules");
  await write(NodePath.join(paths.codexHome, "skills", "beta", "SKILL.md"), skill("beta"));
  await write(NodePath.join(paths.agentsHome, "skills", "gamma", "SKILL.md"), skill("gamma"));
  await write(
    NodePath.join(paths.codexHome, "config.toml"),
    [
      'model = "neutral"',
      'notify = ["notifier", "turn-ended"]',
      '[plugins."browser@bundled"]',
      "enabled = true",
      '[plugins."slides@curated"]',
      "enabled = false",
      "[mcp_servers.repl]",
      'command = "node"',
      'args = ["repl.mjs"]',
      "[mcp_servers.repl.env]",
      'API_KEY = "s3cret"',
      "",
    ].join("\n"),
  );
  await write(NodePath.join(paths.codexHome, "hooks.json"), hookFile("node codex-guard.mjs"));
  await write(paths.codexPolicy[0]!, hookFile("node machine-guard.mjs"));
  await write(NodePath.join(paths.geminiHome, "GEMINI.md"), "gemini rules");
  await write(
    NodePath.join(paths.geminiHome, "config", "skills", "delta", "SKILL.md"),
    skill("delta"),
  );
  await NodeFSP.mkdir(NodePath.join(paths.geminiHome, "config", "plugins", "swarm"), {
    recursive: true,
  });
  await write(
    NodePath.join(paths.geminiHome, "config", "config.json"),
    JSON.stringify({ plugins: { swarm: { enabled: false } } }),
  );
  await write(
    NodePath.join(paths.geminiHome, "config", "hooks.json"),
    JSON.stringify({
      guard: { PreToolUse: [{ matcher: "run_command", hooks: [{ command: "node g.mjs" }] }] },
    }),
  );
  await write(
    NodePath.join(paths.geminiHome, "config", "mcp_config.json"),
    JSON.stringify({ mcpServers: { calendar: { command: "node", env: { TOKEN: "s3cret" } } } }),
  );
  return { root, paths };
}

/** File path to content hash, for proving a tree was not written. */
export async function hashTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await NodeFSP.readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = NodePath.join(entry.parentPath, entry.name);
    out[path] = NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(path))
      .digest("hex");
  }
  return out;
}
