# Evidence for "agents fork threads with t3_thread_transfer"

Raw data and scripts behind the trials in the PR from branch `fix/agents-find-thread-fork`.
Nothing here is part of the PR.

| File | What it is |
|---|---|
| `results.jsonl` | First set: 10 + 10 plan trials and 4 + 4 act trials, one row per fresh Opus 5.5 thread |
| `results-heldout.jsonl` | Second set, run later: 10 + 10 plan trials |
| `results-set3.jsonl` | Third set, run after the replay case's checks were fixed: 10 + 10 plan trials and 5 + 5 runs of the case's own prompt. Every row stores the guidance file's hash and the server start time. |
| `set3/` | Third set: shuffled replies, key and blind grades (the out-of-sample check of the case: 30 of 30 agree) |
| `run-arm.sh` | Runs one arm from start to end: sets the guidance file, starts one dev stack, runs the trials, stops the stack, restores the file |
| `results-case-wording1.jsonl` | 5 trials on `main` with the case's first wording ("Now fork thread B…"): 5 of 5 found the tool, so the case does not use that wording |
| `blind-replies.md`, `grading-key.json`, `blind-grades.txt` | First set: shuffled unlabelled replies, the key, and the blind grades |
| `regrade/` | The first set reshuffled with a new seed and graded again: same grade on 20 of 20 |
| `heldout/` | Second set: shuffled replies, key and blind grades |
| `grade-prompt.md` | The grader's model and prompt, word for word |
| `recount.mjs`, `recount.json` | Every tool call, counted from the Claude Code provider logs |
| `case-check.mjs` | Applies the replay case's checks to 7 fixed replies and to the real replies, and compares with the blind grades (40 of 40 on sets 1 and 2, which the checks were written from; 30 of 30 on set 3) |
| `trial.mjs`, `trials.config.json`, `t3dev.mjs` | The trial runner against a separate dev T3 instance |
| `make-blind.mjs`, `compare-grades.mjs`, `set-case.mjs` | Shuffle for blind grading, compare two gradings, write the replay case |
| `arms.log` | Which guidance text the server had for each held-out arm |

| Set | `main` | This branch |
|---|---|---|
| First | 6 / 10 | 10 / 10 |
| Second | 3 / 10 | 10 / 10 |
| Third | 3 / 10 | 10 / 10 |
| Third, the case's own prompt | 3 / 5 | 5 / 5 |
