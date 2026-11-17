const KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const TABLE_HEADER = new RegExp(String.raw`^\[\s*(${KEY}(?:\s*\.\s*${KEY})*)\s*\]\s*(?:#.*)?$`);
const KEY_LINE = new RegExp(String.raw`^(${KEY}(?:\s*\.\s*${KEY})*)\s*=`);
const KEY_PART = new RegExp(KEY, "g");

const unquote = (key: string) =>
  key.startsWith('"')
    ? key.slice(1, -1).replaceAll(/\\(.)/g, "$1")
    : key.startsWith("'")
      ? key.slice(1, -1)
      : key;

const splitKey = (dotted: string) => (dotted.match(KEY_PART) ?? []).map(unquote);

/**
 * Names of the MCP servers a Codex `config.toml` defines, in `[mcp_servers.<name>]` tables,
 * a `[mcp_servers]` table, or dotted keys. Only these may get `mcp_servers.<name>.enabled`.
 */
export function parseCodexConfigMcpServerNames(toml: string): ReadonlyArray<string> {
  const names = new Set<string>();
  let table: ReadonlyArray<string> = [];
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    // Array-of-tables entries never define servers.
    if (line.startsWith("[[")) {
      table = ["[["];
      continue;
    }
    const header = TABLE_HEADER.exec(line);
    if (header !== null) {
      table = splitKey(header[1]!);
      if (table[0] === "mcp_servers" && table[1] !== undefined) names.add(table[1]);
      continue;
    }
    const keyLine = KEY_LINE.exec(line);
    if (keyLine === null) continue;
    const path = [...table, ...splitKey(keyLine[1]!)];
    if (path[0] === "mcp_servers" && path[1] !== undefined) names.add(path[1]);
  }
  return [...names];
}
