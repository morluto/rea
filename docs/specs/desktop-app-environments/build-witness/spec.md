# Build and witness

## Outcome

An agent that builds a desktop app environment on a build computer captures
the app with REA inside the computer, marks the seed and the end and gets an
acknowledgement for each, drafts the task, exports the bundle with the task
it wrote and brings the bundle back to the host, all through REA's MCP tools.
It then witnesses the task live in a fresh computer of that bundle: the seed
fails a check, the edit made from the prompt passes every check, a near miss
fails one, and after `data/reset` one fails again. REA keeps the action log
and the recording and writes the record as Evidence.

## Requirements

- MCP-only session tools in the `application` family, on a build computer's
  `computer_id`: `start_build_capture`, `mark_build_checkpoint`,
  `stop_build_capture`, `export_build_environment` and `check_build_task`, and
  a `reset` action of `act_on_build_computer`.
- Commands in the computer go through agentenv's `computer-exec/v1` route
  with the control token, which stays in REA and is removed from any output
  REA reports. A controller, `bridge/agentenv/capture.py`, travels with each
  command as `python3 -I -c`; it runs REA as the session user in the home
  without `AGENTENV_*` variables and with `APT_CONFIG` naming apt lists it
  downloads into `~/.rea-build/apt` before the first capture.
- The capture runs detached, its stdin a FIFO it holds open for reading and
  writing; a shell around it records its exit status. `~/.rea-build` is left
  out of every walk. A start returns once the capture reports the window
  open; a refused or early-ended start stops the capture and reports its
  output.
- Acknowledgement: `capture-desktop-application` reports, beside each progress
  message, an `event`: `window_open`; `checkpoint` with its name, trigger,
  time, entries walked, changes and retained files and bytes, once it is
  taken, the baseline, `stop` and `exit` included; and `checkpoint_refused`
  with the reason. `mark_build_checkpoint` writes `checkpoint <name>` and
  waits for the event naming it, returning its counts. Names follow a narrow
  pattern, without the capture's own names; a name already taken is refused.
- `stop_build_capture` sends `stop`, waits for the exit status, reads the
  capture's Evidence and, when `seed` and `end` were acknowledged, runs
  `describe-desktop-application-task --seed-checkpoint seed --end-checkpoint
  end` and returns the changed files, their net change and suggested checks.
- `export_build_environment` writes the agent's task under `~/.rea-build`,
  runs `export-desktop-application` with it and the same checkpoints into a
  new folder there, reports a refused task with the export's own reason,
  lists the bundle with sizes and SHA-256, fetches it through the driver's
  `data/get` in answers of at most 8 MiB, checks each file and writes the
  caller's new or empty folder through the safe output tree.
- `check_build_task` reads the one app's `data/get` through the card's
  child URL, takes the state views beside its files and evaluates the task's
  checks with `evaluateTaskChecks`, one result per check. With `stage`, the
  checks file a witness stage: `seed` (with `directory`) starts a recording
  and must fail a check; `after_edit` must pass all; `near_miss` must fail
  one; `after_reset` must fail one. Stages come in order, for one task; the
  edit and the near miss each need an applied input action since the stage
  before, `after_reset` a reset as the last change. A stage that does not hold,
  or the last, ends the witness: the recording ends, its segments are fetched
  and checked, and `directory` gets the segments and `witness.json`, Evidence
  of the verdict, the stages, the action log and the recording.
- The `reset` action calls the app's `data/reset`, then waits for the
  computer's readiness checks, since the reset relaunches the app.
- Gaps of the build computer's first real run: a packing script for
  `REA_BUILD_COMPUTER_REA_ARCHIVE`; build and exported apps start in the home
  (the captured working directory), not in agentenv's folder for the app; and
  MCP progress notifications every five seconds while a computer starts and
  while the capture, draft, export and witness tools work.

- Retries keep ownership: a start whose answer is lost stops its capture,
  and REA keeps a capture whose stop is unconfirmed, retrying that stop
  before another start; a lost checkpoint acknowledgement comes back from
  the capture's log; a stop resumes reading its result or repeats it; the
  draft and export read the checkpoints from the capture's Evidence; a seed
  check that failed after opening is asked again with its task and folder;
  a record whose save failed is written again on a repeat of its stage.
- The edit and the near miss count only click, drag, scroll, type and key,
  and a reset after the last of them refuses the stage.
- A `.deb` app's file is kept in the build layer for `--package-file`, and
  its URL reaches the export's `--package-url`. A failed `apt-get update`
  reports its status and last lines. The bundle is written as it arrives.

- The witness reads the build computer's bounded action log: its stage rules
  use the log's count and the last applied action of each kind, and the
  record holds the entries the log keeps, `actions_dropped`, and a
  limitation when the log dropped actions or cut arguments.

## Non-goals

- Running the exported `verify.py` in the witness; REA's evaluator is the
  one it mirrors, and the Python parity tests cover the port.
- A witness by a separate solving agent, remote sandbox providers, emulated
  architectures, and choosing the near miss for the agent.
- Recording the build itself; only the witness is recorded.
