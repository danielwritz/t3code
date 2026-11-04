// Compares a rerun of the blind grading with the first grading, by thread id.
// Usage: node tools/trials/compare-grades.mjs <out-dir>   (needs <out-dir>/blind-grades.txt from the grader)
import { readFileSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const dir = process.argv[2];
const grades = (file, keyFile) => {
  const key = Object.fromEntries(JSON.parse(readFileSync(keyFile, "utf8")).map((k) => [k.id, k]));
  return Object.fromEntries(readFileSync(file, "utf8").trim().split("\n").map((l) => l.split("|").map((x) => x.trim()))
    .map(([id, g]) => [key[id].threadId, { g, arm: key[id].arm }]));
};
const first = grades(`${here}blind-grades.txt`, `${here}grading-key.json`);
const again = grades(`${dir}/blind-grades.txt`, `${dir}/grading-key.json`);
let same = 0;
for (const [t, a] of Object.entries(first)) {
  const b = again[t];
  if (b?.g === a.g) same++; else console.log(`differs: ${t} (${a.arm}) first ${a.g}, rerun ${b?.g}`);
}
const pass = (g, arm) => Object.values(g).filter((x) => x.arm === arm && x.g === "PASS").length;
console.log(`same grade on ${same} / ${Object.keys(first).length}; rerun passes: before ${pass(again, "before")}/10, after ${pass(again, "after")}/10`);
