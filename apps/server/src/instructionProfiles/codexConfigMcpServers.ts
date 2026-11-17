const KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const TABLE_HEADER = new RegExp(String.raw`^\[\s*(${KEY}(?:\s*\.\s*${KEY})*)\s*\]\s*(?:#.*)?$`);
const KEY_LINE = new RegExp(String.raw`^(${KEY}(?:\s*\.\s*${KEY})*)\s*=`);
const KEY_PART = new RegExp(KEY, "g");
// Codex fails to open a session for an `mcp_servers.<name>` key that names no server, so
// only plain names are ever reported.
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

const unquote = (key: string) =>
  key.startsWith('"')
    ? key.slice(1, -1).replaceAll(/\\(.)/g, "$1")
    : key.startsWith("'")
      ? key.slice(1, -1)
      : key;

const splitKey = (dotted: string) => (dotted.match(KEY_PART) ?? []).map(unquote);

/** Lines that start outside any string, comment, array or inline table: keys and headers. */
function topLevelLines(toml: string): Array<string> {
  const lines: Array<string> = [];
  let state: "normal" | "basic" | "literal" | "multiBasic" | "multiLiteral" | "comment" = "normal";
  let depth = 0;
  let start = 0;
  let keep = true;
  for (let index = 0; index < toml.length; index++) {
    const character = toml[index]!;
    if (character === "\n") {
      if (keep) lines.push(toml.slice(start, index));
      if (state === "comment" || state === "basic" || state === "literal") state = "normal";
      start = index + 1;
      keep = state === "normal" && depth === 0;
      continue;
    }
    switch (state) {
      case "comment":
        break;
      case "basic":
        if (character === "\\") index++;
        else if (character === '"') state = "normal";
        break;
      case "literal":
        if (character === "'") state = "normal";
        break;
      case "multiBasic":
        if (character === "\\") index++;
        else if (toml.startsWith('"""', index)) {
          index += 2;
          state = "normal";
        }
        break;
      case "multiLiteral":
        if (toml.startsWith("'''", index)) {
          index += 2;
          state = "normal";
        }
        break;
      case "normal":
        if (character === "#") state = "comment";
        else if (toml.startsWith('"""', index)) {
          index += 2;
          state = "multiBasic";
        } else if (toml.startsWith("'''", index)) {
          index += 2;
          state = "multiLiteral";
        } else if (character === '"') state = "basic";
        else if (character === "'") state = "literal";
        else if (character === "[" || character === "{") depth++;
        else if (character === "]" || character === "}") depth = Math.max(0, depth - 1);
        break;
    }
  }
  if (keep) lines.push(toml.slice(start));
  return lines;
}

/**
 * Names of the MCP servers a Codex `config.toml` defines, in `[mcp_servers.<name>]` tables,
 * a `[mcp_servers]` table, or dotted keys. Only these may get `mcp_servers.<name>.enabled`.
 */
export function parseCodexConfigMcpServerNames(toml: string): ReadonlyArray<string> {
  const names = new Set<string>();
  const add = (name: string | undefined) => {
    if (name !== undefined && SAFE_NAME.test(name)) names.add(name);
  };
  let table: ReadonlyArray<string> = [];
  for (const rawLine of topLevelLines(toml)) {
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
      if (table[0] === "mcp_servers") add(table[1]);
      continue;
    }
    const keyLine = KEY_LINE.exec(line);
    if (keyLine === null) continue;
    const path = [...table, ...splitKey(keyLine[1]!)];
    if (path[0] === "mcp_servers") add(path[1]);
  }
  return [...names];
}
