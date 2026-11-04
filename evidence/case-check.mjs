// Offline check of the replay case's text rules against the 20 real plan replies (cost $0).
// It applies the case's textMust / textMustNot from the upstream branch to each reply in
// blind-replies.md, then compares with the blind grades and the arm in grading-key.json.
// Usage: node tools/trials/case-check.mjs [path to threads-vs-tasks.ndjson]
import { readFileSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const casesPath = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null) ?? "D:/tmp/allow-forking/t3code/evals/mcp-tool-use/cases/threads-vs-tasks.ndjson";
const kase = readFileSync(casesPath, "utf8").trim().split("\n").map(JSON.parse)
  .find((c) => c.id === "tt-fork-thread-uses-transfer");
const must = (kase.expect.textMust ?? []).map((p) => new RegExp(p));
const mustNot = (kase.expect.textMustNot ?? []).map((p) => new RegExp(p));
if (!must.length && !mustNot.length) throw new Error("the case has no text rules");

// --results <file>: grade fresh trial rows (held-out replies) with the case's text rules AND its
// callsMustNot, instead of the 20 replies the rules were written from.
const resAt = process.argv.indexOf("--results");
if (resAt > 0) {
  const banned = (kase.expect.callsMustNot ?? []).map((c) => c.tool);
  const rows = readFileSync(`${here}${process.argv[resAt + 1]}`, "utf8").trim().split("\n").map(JSON.parse);
  for (const r of rows) {
    const why = [
      ...must.filter((x) => !x.test(r.reply)).map((x) => `missing ${x}`),
      ...mustNot.filter((x) => x.test(r.reply)).map((x) => `has ${x}`),
      ...r.toolNames.filter((t) => banned.includes(t)).map((t) => `called ${t}`),
    ];
    r.casePass = why.length === 0;
    console.log(`${r.arm.padEnd(6)} ${r.n} case ${r.casePass ? "PASS" : "FAIL"} ${why.join("; ")}`);
  }
  for (const arm of [...new Set(rows.map((r) => r.arm))]) {
    const g = rows.filter((r) => r.arm === arm);
    console.log(`${arm}: ${g.filter((r) => r.casePass).length} / ${g.length} pass`);
  }
  // --blind <dir>: compare with that folder's blind grades (blind-grades.txt + grading-key.json).
  const blindAt = process.argv.indexOf("--blind");
  if (blindAt > 0) {
    const dir = `${here}${process.argv[blindAt + 1]}`;
    const k = Object.fromEntries(JSON.parse(readFileSync(`${dir}/grading-key.json`, "utf8")).map((x) => [x.id, x.threadId]));
    const g = Object.fromEntries(readFileSync(`${dir}/blind-grades.txt`, "utf8").trim().split("\n")
      .map((l) => l.split("|").map((s) => s.trim())).map(([id, gr]) => [k[id], gr]));
    const off = rows.filter((r) => (g[r.threadId] === "PASS") !== r.casePass);
    for (const r of off) console.log(`disagrees with blind grade: ${r.arm} ${r.n} (blind ${g[r.threadId]}): ${r.reply.slice(0, 300).replace(/\n/g, " ")}`);
    console.log(`agree with blind grades on ${rows.length - off.length} / ${rows.length}`);
  }
  process.exit(0);
}

const replies = {};
for (const part of readFileSync(`${here}blind-replies.md`, "utf8").split(/^## /m).slice(1)) {
  const [id, ...rest] = part.split("\n");
  replies[id.trim()] = rest.join("\n");
}
const key = Object.fromEntries(JSON.parse(readFileSync(`${here}grading-key.json`, "utf8")).map((k) => [k.id, k]));
const blind = Object.fromEntries(readFileSync(`${here}blind-grades.txt`, "utf8").trim().split("\n")
  .map((l) => l.split("|").map((s) => s.trim())).map(([id, g]) => [id, g]));

const rows = Object.entries(replies).map(([id, text]) => {
  const failedMust = must.filter((r) => !r.test(text)).map(String);
  const hitMustNot = mustNot.filter((r) => r.test(text)).map(String);
  return { id, arm: key[id].arm, blind: blind[id], casePass: !failedMust.length && !hitMustNot.length, failedMust, hitMustNot };
});
const count = (arm) => rows.filter((r) => r.arm === arm && r.casePass).length + " / " + rows.filter((r) => r.arm === arm).length;
for (const r of rows) console.log(`${r.id} ${r.arm.padEnd(6)} blind ${r.blind.padEnd(4)} case ${r.casePass ? "PASS" : "FAIL"} ${[...r.failedMust, ...r.hitMustNot].join(" ")}`);
const agree = rows.filter((r) => (r.blind === "PASS") === r.casePass).length;
console.log(`\ncase text rules: before ${count("before")}, after ${count("after")}; agree with blind grades on ${agree} / ${rows.length}`);
