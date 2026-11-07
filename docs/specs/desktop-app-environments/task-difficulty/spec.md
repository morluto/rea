# Task difficulty

## Outcome

The building agent can tell how hard a bundle's task is for a model, and
harden it until it lands in a band worth evaluating or training on. One MCP
tool solves the task in fresh computers, adaptively and within a budget, and
records the result in the bundle.

## Requirements

- `measure_build_task` takes `bundle` (an absolute folder on the host),
  `task`, `model`, `agent` (`claude-code` by default) and `budget_usd`. It
  refuses a task whose `tasks/NAME.json` or `artifacts/NAME-check/verify.py`
  the bundle lacks, before any solve.
- Each solve runs `bridge/agentenv/solve.py` with the agentenv runner's
  Python, which calls `run_bundle` for the one task with the model and agent,
  `sandbox="local"` and `emulate=False`, and prints one JSON line: the run's
  outcome, instance id, seconds, each check's result from the instance's
  verifications, the solver's turns and cost from the last record of its
  local trajectory, and agentenv's version; or the error that kept it from
  running. The endpoint is whatever agentenv reads where REA starts; REA holds
  no model client and passes the environment on unread.
- Solves run one at a time. The band: 3 finished solves with 0 passes is
  `too_hard` and with 3 is `too_easy`; otherwise 2 more, and 1 to 3 of 5 is
  `in_band`, 4 `too_easy`. A solve that did not finish (`failed`, `unscored`,
  `cancelled`) is run again, at most twice, and not counted. Before each solve
  the measure stops when the largest cost so far would take the total past the
  budget, and after a solve that reports no cost.
- The result and `difficulty.json` at the bundle's root keep, per task: model,
  agent, time, band, why it stopped, finished solves (`k`), passes,
  unfinished solves, cost and budget, each finished solve's turns, failures
  per check, each solve, the task's digest (SHA-256 of its steps file then its
  verifier) and REA's and agentenv's versions. A task measured again replaces
  its own record. The README's Measured difficulty section lists each task.
- A solve that could not run ends the measure with its error and writes
  nothing. A `difficulty.json` or README that exists but cannot be read
  or parsed is refused before any solve and again before writing, and left
  as it is; record writes to one bundle run one at a time.
- A helper still running after the stop grace has its process group cleared
  before REA reads its report, and that read waits at most 5 s. A helper whose
  cleanup fails raises a cleanup error naming its process group, and REA keeps
  it so closing retries the cleanup. Cancelling, or REA closing its build computers, stops the running
  solve, whose run tears its computer down.
- The building guide tells the agent how to measure, how to read failures per
  check for brittle checks, and how to harden a task that is too easy while
  keeping it sound.

## Non-goals

- No parallel solves, no other model than the solver's, and no judge: the
  verifier's checks decide every solve.
- No cost cap inside a solve: the budget is checked between solves.
