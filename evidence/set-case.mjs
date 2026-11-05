// Writes the upstream replay case tt-fork-thread-uses-transfer (prompt and text rules) into the clone.
// Usage: node tools/trials/set-case.mjs   The rules were written from the 40 replies of sets 1 and 2;
// they were fixed before any set-3 reply was read (7 of set 3's 30 trials had already run), so set 3
// (results-set3.jsonl) is the out-of-sample check (case-check.mjs).
import { readFileSync, writeFileSync } from "node:fs";
import { AFW } from "../root.mjs";
const p = `${AFW}/t3code/evals/mcp-tool-use/cases/threads-vs-tasks.ndjson`;
const lines = readFileSync(p, "utf8").replace(/\n$/, "").split("\n");
const i = lines.findIndex((l) => l.includes('"tt-fork-thread-uses-transfer"'));
const c = JSON.parse(lines[i]);
c.prompt = "I want to repeat our comparison process: take the Fable thread and fork it, then get the fork to read the Opus answer and write one combined answer. Do not start yet. Understood? Tell me the threads this will create and how you will make each one (agent, model).";
// textMust: the plan names T3's own fork (the tool, its fork action, or "I'll fork thread B").
c.expect.textMust = [
  String.raw`t3_thread_transfer|\b(?:I'll|I will|I'd|I would|I can) (?:\w+ )?fork\b|\b[Ff]ork(?:ing)? (?:action|tool)\b|thread-fork action|T3's (?:thread )?transfer`,
];
c.expect.textMustNot = [
  // a plan that hands the fork back to the user, or copies B's history into a new thread
  String.raw`\b[Cc]lick (?:the )?\W{0,2}Fork`,
  String.raw`\b(?:past(?:e|es|ing)|seed(?:s|ed|ing)?)\b[^.\n]{0,50}\b(?:conversation|history|transcript)\b`,
  String.raw`\bseeded with\b`,
  // added after round 3 of the review: a "fork" made as a new thread whose first message holds the
  // history, even when the reply also says "I'll fork"
  String.raw`\b(?:conversation|history|transcript)\b[^.\n]{0,60}\bfirst (?:message|prompt)\b|\bfirst (?:message|prompt)\b[^.\n]{0,60}\b(?:conversation|history|transcript)\b`,
  String.raw`(?<!(?:n't|not|never) )\b(?:creat|start|mak|open|launch)\w* (?:a |one |the )?(?:new |fresh |separate )?thread (?:with|using|via|through) \W?(?:t3_thread_launch|create_threads)\b`,
  // a plan that says T3 cannot fork
  String.raw`\b[Nn]o (?:real |true |native |built-in )?fork\b`,
  String.raw`\b(?:has|have) no (?:tool|built-in|way)[^.\n]{0,30}\bfork`,
  String.raw`n.t have an? (?:true |real )?fork\b`,
  String.raw`n.t have an? (?:tool|way)[^.\n]{0,30}\b(?:fork|clone)`,
  String.raw`\b[Nn]one of (?:my|the|them)\b[^.\n]{0,30}\bcan (?:truly |really )?fork`,
  String.raw`\b(?:can.t|cannot|can not) (?:truly |really )?fork`,
];
lines[i] = JSON.stringify(c);
writeFileSync(p, lines.join("\n") + "\n");
console.log(`wrote ${c.expect.textMust.length} textMust and ${c.expect.textMustNot.length} textMustNot rules`);
