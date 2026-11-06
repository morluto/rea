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
- `start_build_capture` takes `state_paths`, at most 16 files or folders in
  the home, relative to it, after `~/` or absolute, without `..` and not the
  home itself; the controller resolves each under the computer's home, both
  as named and with its links followed (a path not there yet through its
  nearest existing folder), refuses one outside it or in `~/.rea-build`
  either way before launching anything, and passes each as named to the
  capture as `--state-path`. A selected file is a document, or the app's own
  state under a hidden folder of the home as named, before links.
- Acknowledgement: `capture-desktop-application` reports, beside each progress
  message, an `event`: `window_open`; `checkpoint` with its name, trigger,
  time, entries walked, changes and retained files and bytes, and up to ten
  changed files, home-relative, those under a selected path first, then
  those the app held open, caches and browser-engine storage last, with a count
  of the rest, once it is taken, the baseline, `stop` and `exit` included;
  and `checkpoint_refused` with the reason. `mark_build_checkpoint` writes
  `checkpoint <name>` and waits for the event naming it, returning its counts
  and changed files, both `null` when the REA in the computer predates them
  and its event leaves them out. Names follow a narrow pattern, without the capture's own
  names; a name already taken is refused.
- `stop_build_capture` sends `stop`, waits for the exit status, reads the
  capture's Evidence and, when `seed` and `end` were acknowledged, runs
  `describe-desktop-application-task --seed-checkpoint seed --end-checkpoint
  end` and returns the changed files, their net change and suggested checks.
  A draft with no files carries `notes`, coded `no_change`,
  `unowned_changes` (up to five changed home paths with their roles, and a
  count of the rest), `uncheckable_changes` (dconf databases whose app keys
  changed, which no check reads) and `no_document`.
- `export_build_environment` writes the agent's task under `~/.rea-build`,
  runs `export-desktop-application` with it and the same checkpoints into a
  new folder there, reports a refused task with the export's own reason,
  lists the bundle with sizes and SHA-256, fetches it through the driver's
  `data/get` in answers of at most 8 MiB, checks each file and writes the
  caller's new or empty folder through the safe output tree. The export
  leaves lock files the app holds while it runs out of the seed, but never a
  document or selected path, listing them in its limitations and README; a
  start from a bundle whose computer never gets ready names the files its
  seed holds by a profile lock's name or as a document lock.
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
  its URL reaches the export's `--package-url` only when the capture's
  package facts say apt does not install it, as the export itself decides.
  A failed `apt-get update` reports its status and last lines. The bundle is
  written as it arrives.
- Gaps of a blind validation run: the desktop Trash is never the app's state
  or a document, so a file the builder trashed is neither owned nor seeded,
  and the export's limitations name what the Trash held at the seed; a
  start from a bundle folder writes no bytecode into it; the first
  screenshot waits, briefly and bounded, until the frame is not one colour.
- Gaps of the blind validation's solve runs: the exported app opens the
  seed's one document at launch, when its desktop entry takes files, so a
  solving agent starts in the document rather than on the app's start
  screen; and `export_build_environment` passes `--synthetic-seed`, so the
  README says the seed was made for the task instead of calling it the
  user's real data.

- Gaps of the second review: calls on one computer (actions, capture
  steps, checks and close) run one at a time in arrival order, so a stage's
  admission, read and filing see no other call, while computers run side by
  side; a close cancels the call in progress and refuses those waiting. The
  witness's recording has one request id per computer, so a seed retried
  after a lost reply asks for the recording it began. A check that fails for
  want of a readable or whole view is `undecided` and proves nothing; a
  stage only such checks would settle files nothing and can be checked
  again. Undecided includes a failure to find a line, row or value that may
  lie in what a cut view left out, and any text check of an element in a cut
  view, which may have lost text from between the element's runs; any other
  check that passes on what the view kept stays decided. The export likewise keeps a task only when a check
  fails on what the seed's view shows. The controller writes a folder's file
  list to a file that REA reads through `data/get`, so a large bundle's list
  is not cut at the 1 MiB of a command's output.
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
