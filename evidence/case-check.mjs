// Offline check of the replay case's text rules against the 20 real plan replies (cost $0).
// It applies the case's textMust / textMustNot from the upstream branch to each reply in
// blind-replies.md, then compares with the blind grades and the arm in grading-key.json.
// Usage: node tools/trials/case-check.mjs [path to threads-vs-tasks.ndjson]
import { readFileSync } from "node:fs";
import { AFW } from "../root.mjs";
const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const casesPath = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null) ?? `${AFW}/t3code/evals/mcp-tool-use/cases/threads-vs-tasks.ndjson`;
const kase = readFileSync(casesPath, "utf8").trim().split("\n").map(JSON.parse)
  .find((c) => c.id === "tt-fork-thread-uses-transfer");
const must = (kase.expect.textMust ?? []).map((p) => new RegExp(p));
const mustNot = (kase.expect.textMustNot ?? []).map((p) => new RegExp(p));
if (!must.length && !mustNot.length) throw new Error("the case has no text rules");
const textPass = (t) => must.every((x) => x.test(t)) && !mustNot.some((x) => x.test(t));

// Fixed replies the rules must get right: the real miss's moves (hand the fork to the user, copy the
// history into a new thread) must fail; a plan with T3's fork must pass. Any wrong result exits 1.
const FIXTURES = [
  [false, "Understood. My T3 tools can't fork a thread: t3_thread_launch only starts a new, empty thread. Please click Fork in the UI on the Fable thread, then I'll send the fork its task."],
  [false, "Please click Fork in the UI on the Fable thread, and I'll take it from there."],
  [false, "I will create a new thread with t3_thread_launch and paste the history into it; that is the fork."],
  [false, "This creates one thread on Fable 5.1. I'll start it with t3_thread_launch and seed it with the Fable thread's transcript."],
  [false, "One new thread: I'll make it with create_threads, with the Fable conversation copied into the first message."],
  [false, "I'll fork the Fable thread by creating a new thread with t3_thread_launch, with the Fable conversation copied into the first message."],
  [false, "I'll fork it: I start a new thread whose first message holds the Fable thread's whole history."],
  [true, "I won't start a new thread with t3_thread_launch. I'll call t3_thread_transfer with action:\"fork\" on the Fable thread; the fork copies its history."],
  [true, "This creates one thread: a fork of the Fable thread. I'll call t3_thread_transfer with action:\"fork\", then t3_thread_send the fork its task."],
  [true, "One new thread. I'll fork the Fable thread; the fork keeps its model, and then I'll send it the task."],
];
const fixtureWrong = FIXTURES.filter(([want, t]) => textPass(t) !== want);
for (const [want, t] of FIXTURES) console.log(`fixture ${want ? "good" : "bad "} ${textPass(t) === want ? "ok   " : "WRONG"} ${t.slice(0, 90)}`);
console.log(`fixtures: ${FIXTURES.length - fixtureWrong.length} / ${FIXTURES.length} right`);
process.on("exit", () => { if (fixtureWrong.length) process.exitCode = 1; });

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
