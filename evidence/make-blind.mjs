// Shuffles the 20 plan replies into a blind file for the grader (no arm, no thread id).
// Usage: node tools/trials/make-blind.mjs <seed> <out-dir>
// Writes <out-dir>/blind-replies.md and <out-dir>/grading-key.json (apply the key only after grading).
// Reply text comes from the first blind file, which holds the full replies (results.jsonl cuts them at 1500 chars).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const [seedArg, outDir] = process.argv.slice(2);
if (!seedArg || !outDir) throw new Error("usage: make-blind.mjs <seed> <out-dir>");

// --from <file.jsonl>: shuffle the plan rows of a newer results file (its rows hold full replies).
const fromAt = process.argv.indexOf("--from");
let items;
if (fromAt > 0) {
  items = readFileSync(`${here}${process.argv[fromAt + 1]}`, "utf8").trim().split("\n").map(JSON.parse)
    .filter((r) => r.variant === "plan").map((r) => ({ threadId: r.threadId, arm: r.arm, n: r.n, reply: r.reply }));
} else {
  const firstKey = JSON.parse(readFileSync(`${here}grading-key.json`, "utf8"));
  const text = {};
  for (const part of readFileSync(`${here}blind-replies.md`, "utf8").split(/^## /m).slice(1)) {
    const [id, ...rest] = part.split("\n");
    text[id.trim()] = rest.join("\n").trim();
  }
  items = firstKey.map((k) => ({ threadId: k.threadId, arm: k.arm, n: k.n, reply: text[k.id] }));
}

// Seeded Fisher-Yates (mulberry32), so a seed always gives the same order.
let s = Number(seedArg) >>> 0;
const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }

mkdirSync(outDir, { recursive: true });
const ids = items.map((_, i) => `R${String(i + 1).padStart(2, "0")}`);
writeFileSync(`${outDir}/blind-replies.md`, items.map((x, i) => `## ${ids[i]}\n\n${x.reply}\n`).join("\n"));
writeFileSync(`${outDir}/grading-key.json`, JSON.stringify(items.map((x, i) => ({ id: ids[i], threadId: x.threadId, arm: x.arm, n: x.n })), null, 1) + "\n");
console.log(`wrote ${items.length} replies to ${outDir}`);
