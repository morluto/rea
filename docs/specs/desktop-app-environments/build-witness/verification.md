# Verification

Run on 2026-11-05: gates and source tests on macOS 26.5 with Node v22.23.1
and Python 3.11; Linux tests and the real run on Ubuntu 24.04 amd64 with
Docker, agentenv-framework 0.9.1431 and Node v24.22.1.

## Tests

Each new test fails on the code before this change, run from that code with
only the new tests and fixtures added: on macOS, and on Linux for the
capture's acknowledgements.

- `src/application/desktop/DesktopApplicationCapture.test.ts` (Linux): the
  capture reports the baseline, `window_open`, `seed` with the counts its
  checkpoint recorded, a refused second `seed`, then `stop` and `exit`.
  Before, no event reached the driver and the test ran out of time.
- `src/domain/desktop/buildWitness.test.ts`: each stage's expectation, the
  order of stages with the actions each needs, and the app's state views.
- `src/domain/desktop/computerActions.test.ts`: `reset` maps to
  `data/reset` and takes only `screenshot`.
- `src/domain/desktop/appExport.test.ts`, `appBuild.test.ts`: exported and
  build apps start in the captured working directory, `"$HOME"` for the home.
- `tests/boundary/mcp/buildCaptureMcp.test.ts`: through the MCP tools, a
  request computer whose `computer-exec` runs REA's real controller on this
  host, against a REA stand-in that acknowledges requests as the capture
  does and prints what the real CLI wrote for a seed-and-end capture: package
  lists under `APT_CONFIG` (compressed, as Ubuntu keeps them), the start with
  a screenshot, `seed` with its counts, a repeated and a reserved name
  refused, `end`, the draft, and the export with the task, whose files arrive
  byte for byte. REA ran without `AGENTENV_*`, in the home, with
  `--exclude ~/.rea-build` and both checkpoints. Steps out of order and a
  capture on a bundle's computer are refused. No result holds the token.
- `tests/boundary/mcp/buildWitnessMcp.test.ts`: a plain check; the witness
  with a fake app whose state the test changes; the edit refused before an
  action, `after_reset` before a reset; the reset relaunch; the record with
  four held stages, the action log, the recording segment and
  `witness.json` read back as Evidence; a seed that already passes ends the
  witness as failed and later stages are refused; `directory` missing or not
  empty is refused.
- PR 2's boundary tests now share `tests/fixtures/buildComputerMcp.ts`.

## Gates

`typecheck`, `format:check`, `build:cached`, `knip`, `jscpd`, `docs:check`,
`docs:build`, `verify:test-discovery`, `verify:architecture-guards`,
`verify:module-boundaries` and `mcp-catalog:check` passed. `lint` and
`lint:typed` fail only on main's `tests/acceptance/webSourceLocationCli.test.ts`.
jscpd's one clone in a touched file is the existing pair of cancellation
tests in `DesktopApplicationCapture.test.ts`. The desktop, contract, schema,
CLI-parity and build boundary tests passed on macOS (Linux-only cases
skipped) and, on Linux, the desktop and build tests ran 467 passed.

## Real computer

REA's archive was packed from this tree with `npm run
pack:build-computer-runtime`, 16.8 MiB in 54 s. Through `rea mcp` over stdio,
driven as the building agent:

- `start_build_computer` from the Mousepad request built its image and came
  up in 80 s, with an MCP progress notification every 5 s naming agentenv's
  stage. A later start took 22.5 s.
- `start_build_capture` returned in 7.3 s with Mousepad open under capture.
  A typed two-line list saved through Save As, which opened on the home, as
  `~/Documents/todo.txt`; `seed` was acknowledged in 0.45 s (54 entries, 7
  changes, 4 files retained) and a second `seed` refused; a third line saved,
  `end` in 0.45 s.
- `stop_build_capture` took 1.7 s: checkpoints `baseline`, `seed`, `end`,
  `stop`, `exit`; `mousepad` 0.6.1-1build2 from `noble/universe`; the draft's
  one file, `Documents/todo.txt`, with the line added and a suggested
  `lines_present`. This run counted 0 package lists, because apt keeps them
  as `*_Packages.lz4`; the count was fixed and a later start reported 15.
- `export_build_environment` refused a `line_count` without `exact` or
  `contains` with the export's reason, then exported the task in 1.3 s: 9
  files, 50,846 bytes, `failing_on_seed` `dentist` and `one-dentist`, seed
  `Documents/todo.txt`, nothing left unscrubbed, and the app launched with
  `cd "$HOME"`. `close_build_computer` took 0.5 s.
- A fresh computer of the bundle came up in 72 s. The witness held: seed
  failed two checks; the line added through Open and Save passed all three;
  `call the dentists` failed `dentist`; the reset, ready in 0.8 s, relaunched
  Mousepad and its check failed two again. The record has 15 actions and 5
  recording segments, 68.6 s and 1.2 MB, written with `witness.json`.
- Every computer closed with `teardown: "agentenv"`; Docker held only the
  local registry it had before. The MCP server's log never names a token.

## Review fixes

Run on macOS after the first review; the VM was not used. Each new test
failed on the reviewed head, with only the new tests and fixtures added, and
passes now. The fake computer now runs a command and then loses its reply
when a test asks, fails an app's `data/get` and keeps a relaunched app
unready for some polls.

- `buildWitness.test.ts`: a reset is neither the edit nor the near miss, and
  a reset after the last input refuses them; a near miss made after a reset
  is admitted.
- `appBuild.test.ts`: the build layer copies a `.deb` to
  `/opt/rea/package.deb` before the app's own install removes it.
- `BuildComputerController.test.ts`: each checked answer is handed over
  before the next is fetched.
- `buildCaptureRetryMcp.test.ts`: a start whose reply was lost stops its
  capture, and while that stop's reply is lost too REA refuses another start
  naming the capture, then retries the stop first; a lost checkpoint reply
  comes back on a repeat; a stop whose draft reply was lost finishes on a
  repeat and repeats its result, and the export follows; apt's exit 100 and
  message reach `package_lists_error`; a `.deb` request captures with
  `--package-file` and exports with `--package-url`.
- `buildWitnessMcp.test.ts`: a seed whose read failed is checked again with
  the one recording; a record whose save was refused is saved on a repeat of
  `after_reset` without reading the app again; a slow reset sends progress.

## Bounded action log

Run on macOS after merging the build computer's bounded action log; the VM
was not used. The stage rules now read the log's count and the last applied
action of each kind, and the record its kept entries.

- `buildWitness.test.ts`: every earlier admission case, through the log a
  list of actions makes, and the rules over a log of 1,000 actions whose
  earliest are dropped.
- `buildWitnessMcp.test.ts`: a witness of 263 actions, one typing 2 KiB,
  is admitted at every stage and held; its record keeps 256 actions from
  index 7 with `actions_dropped` 7, names `text` in the typed action's
  `truncated_arguments`, and its Evidence states both limitations.

## Limits of this verification

- The witness acts were scripted by this agent from the task's prompt; no
  separate solving agent ran, and the exported `verify.py` was not run.
- Only the local provider on amd64, and only Mousepad.
