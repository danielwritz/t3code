// Reads the T3 CLI's --json output on stdin and prints one field of it.
//   node src/bin.ts thread start ... --json | node tools/cli-json.mjs threadId
// The CLI can print log lines first, and some of them start with "{" too (for example
// "{ reason: 'SQLite 3.50.4 has no NOOP checkpoint' }"), so this parses from the first line that
// starts with '{"' (a real JSON object) to the end.
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  // A JSON object starts a line with '{"' (one line) or is a line of just "{" (pretty-printed).
  const at = s.search(/^\{\s*(?:"|$)/m);
  if (at < 0) { console.error(`no JSON object in the CLI output:\n${s.slice(0, 500)}`); process.exit(1); }
  const field = process.argv[2];
  const obj = JSON.parse(s.slice(at));
  if (field && !(field in obj)) { console.error(`no field ${field} in ${JSON.stringify(obj).slice(0, 300)}`); process.exit(1); }
  console.log(field ? obj[field] : JSON.stringify(obj));
});
