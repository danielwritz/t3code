// One fork-discovery trial on a SEPARATE dev T3 instance (never the user's live T3).
// Usage: node tools/trials/trial.mjs <arm-label> <trial-number> <variant: act|plan|case>
// Config: trials.config.json next to this file (T3 home, server folder, project id, thread A and B).
// Starts a fresh Opus 5.5 thread with a fork task that names no tool, waits for it, then reads
// every tool call from the Claude Code provider log. Appends one JSON line to results.jsonl.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { AFW } from "../root.mjs";

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const cfg = JSON.parse(readFileSync(`${here}trials.config.json`, "utf8"));
// base and server in the config are relative to the root (tools/root.mjs).
for (const k of ["base", "server"]) if (!/^[A-Za-z]:/.test(cfg[k])) cfg[k] = `${AFW}/${cfg[k]}`;
const [arm, n, variant = "act"] = process.argv.slice(2);
if (!arm || !n) throw new Error("usage: trial.mjs <arm> <n> <act|plan|case>");
if (!cfg.base.startsWith(`${AFW}/`)) throw new Error(`refusing T3 home ${cfg.base}`);
const { A, B } = cfg;
const env = { ...process.env };
delete env.T3CODE_HOME;

// Close to the user's real words on 2026-11-04 ("take the other fable thread and fork it and get it
// to do the same reflection step"). No tool name, no hint.
const PROMPTS = {
  act: `Two threads answered the same pricing question: "Pricing question: answer A" (${A}) and "Pricing question: answer B" (${B}). Take thread B and fork it, and get the fork to do a reflection step: read answer A, compare it with its own answer, and write one combined answer. Tell me the fork's thread id once it is started.`,
  // The real miss: the user asked for the plan first, and the agent said T3 cannot fork.
  plan: `Two threads answered the same pricing question: "Pricing question: answer A" (${A}) and "Pricing question: answer B" (${B}). I want to repeat our reflection process: take thread B and fork it, then get the fork to read answer A and write one combined answer. Do not start yet. Understood? Tell me the threads this will create and how you will make each one (agent, model).`,
  // The upstream replay case's prompt (tt-fork-thread-uses-transfer), with the two threads named
  // here because a real thread has no synthetic prior turns.
  // Set 3: the submitted case's prompt word for word, after one sentence that stands in for the
  // case's prior turns (which name an Opus thread and a Fable thread).
  case: `Earlier I asked Opus and Fable the same pricing question in two threads. Opus: "Pricing question: answer A" (${A}). Fable: "Pricing question: answer B" (${B}). I want to repeat our comparison process: take the Fable thread and fork it, then get the fork to read the Opus answer and write one combined answer. Do not start yet. Understood? Tell me the threads this will create and how you will make each one (agent, model).`,
  // Negative control (results-control.jsonl): the user wants a NEW thread, not a fork. With the line,
  // the agent must still start a new thread and must not fork.
  newthread: `Start a new thread in this project on Claude Haiku 5.5, titled "Pricing summary", that writes a one-line summary of the pricing question in "Pricing question: answer A" (${A}). Tell me its thread id once it is started.`,
  // The case's first wording (results-case-wording1.jsonl): it did not reproduce the miss.
  case1: `Two threads answered the same pricing question: "Pricing question: answer A" (${A}) and "Pricing question: answer B" (${B}). Now fork thread B and have the fork read answer A and write one combined answer. Do not start yet. Tell me the threads this will create and how you will make each one.`,
};
const PROMPT = PROMPTS[variant];
if (!PROMPT) throw new Error(`unknown variant ${variant}`);

// Arm proof, stored in every row: which guidance text the server file has, and when the server
// started (so a row can be matched to the server run that loaded that text).
const guidePath = `${cfg.server}/../../packages/provider-core/src/server/orchestrationInstructions.ts`;
const guide = readFileSync(guidePath, "utf8");
const serverLog = cfg.serverLog ?? `${AFW}/server-demo.log`;
const listening = existsSync(serverLog)
  ? (readFileSync(serverLog, "utf8").match(/\[([0-9:.]+)\][^\n]*Listening on/) ?? [])[1] ?? null
  : null;
const armProof = { guidanceSha256: createHash("sha256").update(guide).digest("hex").slice(0, 16), guidanceHasFix: guide.includes("To fork a thread"), serverListening: listening };

const started = Date.now();
const out = execFileSync("node", ["src/bin.ts", "thread", "start", cfg.project, PROMPT,
  "--title", `Fork trial ${arm} ${variant} ${n}`, "--provider", "claudeAgent", "--model", "claude-opus-5-5",
  "--wait", "--json", "--base-dir", cfg.base], { cwd: cfg.server, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 900_000 });
// The CLI can print log lines first; some start with "{" (see tools/cli-json.mjs), so look for '{"'.
const run = JSON.parse(out.slice(out.search(/^\{\s*(?:"|$)/m)));

// Every tool call, from the provider log. Stream events repeat a call, so key by its id.
const log = `${cfg.base}/userdata/logs/provider/events.${run.threadId.replaceAll(":", "-")}.log`;
const calls = new Map();
if (existsSync(log)) for (const line of readFileSync(log, "utf8").split("\n")) {
  for (const m of line.matchAll(/"type":"tool_use","id":"(toolu_[A-Za-z0-9]+)","name":"([^"]+)","input":(\{[^{}]*\})/g)) {
    let input = {};
    try { input = JSON.parse(m[3]); } catch {}
    if (!calls.has(m[1]) || Object.keys(input).length) calls.set(m[1], { tool: m[2].replace("mcp__t3-code__", ""), input });
  }
}
const list = [...calls.values()];
const searches = list.filter((c) => c.tool === "ToolSearch").map((c) => String(c.input.query ?? ""));
const reply = run.reply ?? "";
const result = {
  arm, variant, n: Number(n), ...armProof, threadId: run.threadId, status: run.status,
  seconds: Math.round((Date.now() - started) / 1000),
  toolCalls: list.length,
  forkedWithTransfer: list.some((c) => c.tool === "t3_thread_transfer" && c.input.action === "fork"),
  launchedNewThread: list.some((c) => c.tool === "t3_thread_launch" || c.tool === "create_threads"),
  searchedForFork: searches.some((q) => !q.startsWith("select:") && /fork/i.test(q)),
  loadedTransferByName: searches.some((q) => q.startsWith("select:") && q.includes("t3_thread_transfer")),
  replyNamesTransfer: /t3_thread_transfer/.test(reply),
  toolNames: list.map((c) => (c.tool === "ToolSearch" ? `ToolSearch(${c.input.query})` : c.tool)),
  reply,
};
appendFileSync(`${here}${process.env.TRIAL_RESULTS ?? cfg.results ?? "results.jsonl"}`, JSON.stringify(result) + "\n");
console.log(JSON.stringify({ ...result, reply: reply.slice(0, 200) }));
