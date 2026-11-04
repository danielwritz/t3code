// Call the SEPARATE dev T3 instance's MCP tools (never the user's own T3).
// Usage: node t3dev.mjs <tool> '<json arguments>'
// Issues a 10-minute read-only mcp-client session with the dev instance's own CLI, revokes it after.
// Base dir is fixed to the dev home so this script cannot reach D:\t3code-trial\home.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = process.env.T3DEV_BASE ?? "D:/tmp/allow-forking/t3home";
if (!BASE.startsWith("D:/tmp/allow-forking/")) throw new Error(`refusing base ${BASE}`);
const SERVER = "D:/tmp/allow-forking/t3code/apps/server";
const env = { ...process.env };
delete env.T3CODE_HOME;
const cli = (args) =>
  execFileSync("node", ["src/bin.ts", ...args, "--base-dir", BASE], {
    cwd: SERVER, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });

const { origin } = JSON.parse(readFileSync(`${BASE}/userdata/server-runtime.json`, "utf8"));
if (!/:13773$/.test(origin)) throw new Error(`refusing: dev origin is ${origin}, expected port 13773`);
const scopes = (process.env.T3DEV_WRITE === "1")
  ? ["--scope", "orchestration:read", "--scope", "orchestration:operate"]
  : ["--scope", "orchestration:read"];
const issued = JSON.parse(cli(["auth", "session", "issue", "--json", "--ttl", "10m", "--label", "t3dev script",
  "--subject", "mcp-client", ...scopes]));

let sessionId = null;
let nextId = 1;
async function rpc(method, params, notify = false) {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${issued.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: nextId++, method, params }),
  });
  sessionId = res.headers.get("mcp-session-id") ?? sessionId;
  const text = await res.text();
  if (notify) return null;
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 500)}`);
  const body = text.trimStart().startsWith("{") ? text : text.split("\n").filter((l) => l.startsWith("data:")).pop().slice(5);
  const msg = JSON.parse(body);
  if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}

try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t3dev", version: "1" } });
  await rpc("notifications/initialized", {}, true);
  const [tool, json] = process.argv.slice(2);
  if (!tool || tool === "list") {
    const { tools } = await rpc("tools/list", {});
    for (const t of tools) console.log(t.name);
  } else {
    const result = await rpc("tools/call", { name: tool, arguments: json ? JSON.parse(json) : {} });
    console.log(JSON.stringify(result.structuredContent ?? result.content, null, 1));
  }
} finally {
  const sid = issued.sessionId ?? issued.session?.sessionId;
  if (sid) try { cli(["auth", "session", "revoke", sid]); } catch (e) { console.error("revoke failed:", e.message); }
}
