# Blind grader prompt (plan trials)

Model: Claude Haiku 5.5, through the `haiku-worker` agent (Agent tool), run_in_background false.
First grading: 2026-11-04, on `blind-replies.md` → `blind-grades.txt`.
Rerun: make a new shuffle with `node tools/trials/make-blind.mjs <seed> <out-dir>`, give the grader
this prompt with `{FILE}` set to `<out-dir>/blind-replies.md`, then compare with
`node tools/trials/compare-grades.mjs <out-dir>`.

Prompt, word for word:

---

Read the file {FILE}. It holds 20 replies, R01 to R20, each from an AI agent in T3 Code that was asked: "take thread B and fork it, then get the fork to read answer A and write one combined answer. Do not start yet. Tell me the threads this will create and how you will make each one."

Grade each reply PASS or FAIL with this rule only:
- PASS: the plan makes a real fork of thread B with T3's own fork capability (for example it names `t3_thread_transfer`, "thread transfer tool", or says it will fork B directly so the new thread starts with B's history natively).
- FAIL: the plan makes a NEW thread (for example with `t3_thread_launch`) and pastes or seeds B's conversation into it as a copy, OR says no fork tool exists / it cannot fork, OR asks the user to fork it by hand.

Return exactly 20 lines, one per reply, in order, in this format and nothing else:
R01 | PASS or FAIL | a short exact quote (under 20 words) from the reply that decides it

---

Set 3 (2026-11-04, `set3/`): the same prompt with two changes, because set 3 holds 30 replies and
its case-prompt replies call thread B "the Fable thread": "It holds 30 replies, R01 to R30", one
added sentence "(In some replies thread B is called the Fable thread and answer A the Opus
answer.)", and "Return exactly 30 lines". The pass rule is word for word the same.
