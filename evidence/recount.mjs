// Recounts every trial from the Claude Code provider logs (the full record of what the agent did),
// instead of from T3's activity view, which leaves out some calls such as t3_thread_read.
// Usage: node tools/trials/recount.mjs [T3 home of the trials, default D:/tmp/allow-forking/t3home]
// Writes recount.json next to this file and prints the per-arm table used in docs/TRIALS.md.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const home = process.argv[2] ?? "D:/tmp/allow-forking/t3home";
const rows = readFileSync(`${here}results.jsonl`, "utf8").trim().split("\n").map(JSON.parse).filter((r) => r.arm !== "dbg");

const out = rows.map((r) => {
  const log = `${home}/userdata/logs/provider/events.${r.threadId.replaceAll(":", "-")}.log`;
  if (!existsSync(log)) throw new Error(`no provider log for ${r.threadId}`);
  // Each tool call is one tool_use block in an assistant message. Stream events repeat it, so key by id.
  const calls = new Map();
  for (const line of readFileSync(log, "utf8").split("\n")) {
    for (const m of line.matchAll(/"type":"tool_use","id":"(toolu_[A-Za-z0-9]+)","name":"([^"]+)","input":(\{[^{}]*\})/g)) {
      let input = {};
      try { input = JSON.parse(m[3]); } catch {}
      if (!calls.has(m[1]) || Object.keys(input).length) calls.set(m[1], { name: m[2].replace("mcp__t3-code__", ""), input });
    }
  }
  const list = [...calls.values()];
  const searches = list.filter((c) => c.name === "ToolSearch").map((c) => String(c.input.query ?? ""));
  return {
    arm: r.arm, variant: r.variant, n: r.n, threadId: r.threadId, seconds: r.seconds,
    toolCalls: list.length,
    tools: list.map((c) => (c.name === "ToolSearch" ? `ToolSearch(${c.input.query})` : c.name)),
    searchedForFork: searches.some((q) => !q.startsWith("select:") && /fork/i.test(q)),
    loadedTransferByName: searches.some((q) => q.startsWith("select:") && q.includes("t3_thread_transfer")),
    usedToolSearch: searches.length > 0,
    forkedWithTransfer: list.some((c) => c.name === "t3_thread_transfer" && c.input.action === "fork"),
    replyNamesTransfer: r.replyNamesTransfer,
  };
});
writeFileSync(`${here}recount.json`, JSON.stringify(out, null, 1) + "\n");

const avg = (xs) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1);
console.log("arm    variant n   toolCalls  seconds  searchedFork  loadedByName  anyToolSearch  namesTransfer  forked");
for (const variant of ["plan", "act"]) for (const arm of ["before", "after"]) {
  const g = out.filter((x) => x.arm === arm && x.variant === variant);
  const c = (k) => `${g.filter((x) => x[k]).length}/${g.length}`;
  console.log(`${arm.padEnd(6)} ${variant.padEnd(7)} ${String(g.length).padEnd(3)} ${avg(g.map((x) => x.toolCalls)).padEnd(10)} ${avg(g.map((x) => x.seconds)).padEnd(8)} ${c("searchedForFork").padEnd(13)} ${c("loadedTransferByName").padEnd(13)} ${c("usedToolSearch").padEnd(14)} ${c("replyNamesTransfer").padEnd(14)} ${c("forkedWithTransfer")}`);
}
