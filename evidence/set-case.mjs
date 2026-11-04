// Writes the upstream replay case tt-fork-thread-uses-transfer (prompt and text rules) into the clone.
// Usage: node tools/trials/set-case.mjs   The rules were fitted on 40 real replies; check with case-check.mjs.
import { readFileSync, writeFileSync } from "node:fs";
const p = "D:/tmp/allow-forking/t3code/evals/mcp-tool-use/cases/threads-vs-tasks.ndjson";
const lines = readFileSync(p, "utf8").replace(/\n$/, "").split("\n");
const i = lines.findIndex((l) => l.includes('"tt-fork-thread-uses-transfer"'));
const c = JSON.parse(lines[i]);
c.prompt = "I want to repeat our comparison process: take the Fable thread and fork it, then get the fork to read the Opus answer and write one combined answer. Do not start yet. Understood? Tell me the threads this will create and how you will make each one (agent, model).";
c.expect.textMustNot = [
  String.raw`\b[Nn]o (?:real |true |native |built-in )?fork\b`,
  String.raw`\b(?:has|have) no (?:tool|built-in|way)[^.\n]{0,30}\bfork`,
  String.raw`n.t have an? (?:true |real )?fork\b`,
  String.raw`n.t have an? (?:tool|way)[^.\n]{0,30}\b(?:fork|clone)`,
  String.raw`\b[Nn]one of (?:my|the|them)\b[^.\n]{0,30}\bcan (?:truly |really )?fork`,
  String.raw`\b(?:can.t|cannot|can not) (?:truly |really )?fork`,
];
lines[i] = JSON.stringify(c);
writeFileSync(p, lines.join("\n") + "\n");
for (const s of c.expect.textMustNot) console.log(s, new RegExp(s).test("There's no real fork tool here"));
