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

## Validation-run fixes

Run on macOS after a blind validation run of the build flow and a review
finding; the VM was not used. Each new test failed on be30603ec with only it
and its fixture changes added, unless noted, and passes now.

- `stateRoles.test.ts`: a path in `~/.local/share/Trash` has the reason
  `desktop_trash` and the role `shared_desktop`, whatever else names it,
  a window title included; `~/.local/share/Trashcan` is not the Trash.
- `DesktopApplicationExport.test.ts`: a file named in the window title and
  moved to the Trash before the seed checkpoint is neither owned nor seeded,
  and a limitation names both of the Trash's files. Before,
  `.local/share/Trash/files` was owned and the file seeded, as the run saw
  with `poster.svg`.
- `buildComputerMcp.test.ts`: the fake runner loads each of the bundle's
  Python files in a child Python as agentenv's `_declare` does, and a start
  from a bundle folder leaves its file list unchanged. Before,
  `envs/notes/__pycache__/notes_app.cpython-311.pyc` appeared. In
  agentenv-framework 0.9.1444 that child is the only Python that imports the
  bundle's files, and it inherits the helper's environment.
- `buildComputerMcp.test.ts`: after two black frames, the start returns the
  third, drawn one; a `region`, `format` or `quality` applies to a screenshot
  taken after it. The fake's frame is now a 2x1 PNG of two colours.
  `PngVisualDiff.test.ts` covers the new one-colour check.
- `buildComputerMcp.test.ts`, after review: with every frame black and the
  third screenshot's reply a minute late, the start returns the second frame
  at the 10 s bound and reports `waiting for the desktop to draw` as
  progress meanwhile. Before, the retry kept its 120 s request timeout and
  progress stopped once readiness passed, so the test ran out of time.
- `buildCaptureRetryMcp.test.ts`: a `.deb` request whose captured package
  apt also offers exports without `--package-url`; one that no apt source
  offers exports with it, from the real CLI's output for that capture (this
  case passed before too). `appExportInstall.test.ts`: the new check agrees
  with the export's own install choice.

`typecheck`, `format:check`, `build:cached`, `knip`, `jscpd`, `docs:check`,
`docs:build`, `verify:test-discovery`, `verify:architecture-guards`,
`verify:module-boundaries` and `mcp-catalog:check` passed; `lint` and
`lint:typed` fail only on main's `tests/acceptance/webSourceLocationCli.test.ts`.
The desktop source tests ran 453 passed (Linux-only cases skipped), and the
build and desktop boundary tests 67 passed with the real test skipped.

Not verified on a real computer: that the first frame not of one colour
shows the panel on the computer's desktop.

## Second review fixes

Run on macOS after the second review; the VM was not used. Each new
boundary test failed on the reviewed head, with only the new tests and
fixtures added, and passes now. The fake computer now cuts a command's
stdout at 1 MiB as the computer does, loses a recording start's reply when
a test asks, and a bundle folder can name the fake computer its start
hands out, so one server can hold two.

- `buildWitnessMcp.test.ts`: two `after_edit` checks sent together file
  one stage, the other is refused as out of order, and `after_reset` stays
  refused until a near miss. Before, both were filed, and after a reset the
  record held with the stages `seed`, `after_edit`, `after_edit`,
  `after_reset`. An `after_reset` check sent while a reset relaunches the
  app waits for it and is admitted; before, it ran during the reset and was
  refused. A seed retried after its recording's start reply was lost asks
  for the same request id; before, a new one. A seed and a near miss whose
  only failing check could not read its file are refused and filed once
  the file reads; before, the read error was filed as the failure.
- `buildComputerMcp.test.ts`: a screenshot sent behind a slow reset on one
  computer answers after it, while a screenshot on another computer answers
  first, and the waiting action sends progress; a close during a reset
  cancels it and refuses an action and a capture step waiting behind it,
  and tears the computer down. Before, the screenshot answered first and
  the close left the reset running.
- `buildComputerLifecycle.test.ts`: the owner's shutdown cancels a call in
  progress and the one waiting behind it.
- `buildCaptureRetryMcp.test.ts`: an export whose bundle's file list is
  about 1.1 MB brings every file back. Before, the list was cut at 1 MiB and
  the export failed with the controller not answering.
- `DesktopBuildTurns.test.ts`: calls run one at a time in arrival order, a
  call that throws frees its turn, a call cancelled while it waits keeps its
  place until the one before it ends, and a close runs once the call it
  cancelled has ended.
- `buildWitness.test.ts` and `appTaskChecks.test.ts`: the three-way stage
  verdict, and which failures are `undecided`.

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

## Failures on cut views

Run on macOS; the VM was not used. The first three tests failed on the
reviewed head, with only the tests and fixtures added, and pass now.

- `appTaskChecks.test.ts`: `lines_present` missing line 5,500 of a
  6,000-line file, `row_present` missing row 501 of a table cut at 500, and
  `value_equals` whose pointer names nothing in a cut text, SQLite, XML or
  zip listing view are undecided; a line, row or value the view kept stays
  decided. Before, each was a decided failure.
- `buildWitnessMcp.test.ts`: a seed and a near miss whose only failing check
  misses `eggs` in a text view cut at 5,000 lines are refused and filed once
  the view is whole. Before, the seed was filed as held.
- `DesktopTaskExport.test.ts`: a task whose only seed failure misses `milk`
  in a 6,000-line note is refused, naming the failure, and with a row check
  that fails on the seed too it is kept with only that check in
  `failing_on_seed`. Before, the export kept the first task.
- `desktopTaskPython.test.ts`: the exported verifier fails the same cut-view
  cases with the same descriptions, as it did before.

## Cancellation after a step

Run on macOS; the VM was not used. A step returns what it saved even when
its call is cancelled or the computer closes as the save finishes; only
`start_build_capture`, which saves nothing, checks after its last await, the
screenshot of the opened app, and ends cancelled. Each test below except the
first failed on the head that cancelled every aborted turn, with only the
tests added, and passes now.

- `buildCaptureRetryMcp.test.ts`: a close while `start_build_capture` waits
  for that screenshot makes it return `cancelled`. Before the start's own
  check, it returned success for the computer being removed. A close while
  an export's bundle commits still returns the bundle; before, `cancelled`.
- `buildWitnessMcp.test.ts`: a close while the witness record commits still
  returns the record, and a check cancelled while it commits gets the saved
  record when asked again; a saved witness's repeated final check returns the
  same record without checking or writing. Before, `cancelled`, and the
  repeat was refused as ended.
- `DesktopBuildTurns.test.ts`: a running call that finishes after a close
  keeps its result.

## Opening the seed's document

Run on 2026-11-05: source tests and gates on macOS; the desktop source tests
again on the Ubuntu 24.04 amd64 VM (40 files, 422 passed, none skipped).

- `seedDocument.test.ts`: the seed's one document is appended when `Exec`
  holds `%F`, `%U`, `%f` or `%u`, and the launch respells it as
  `"$HOME"/'Documents/poster.svg'`; two documents, none, an `Exec` without a
  file field code and a capture without a desktop entry keep the command and
  give the reason; a command already naming a file under the home is kept.
- `appExport.test.ts`: the README says what the launch opens, or why it
  opens nothing; a seed made for the task is worded as such in the README
  and the class, and a captured one as the user's real data.
- `DesktopApplicationExport.test.ts`: from a seed-and-end capture launched
  through `notes %U`, the class launches `notes` with the note; through
  `notes`, or without a desktop entry, and from a baseline seed with no
  document, it launches as captured and a limitation says why;
  `--synthetic-seed` changes the limitation and the README and is recorded
  as `synthetic_seed`.
- `buildCaptureMcp.test.ts`: `export_build_environment` runs the export
  with `--synthetic-seed`, and the real CLI's README for that capture says
  the seed was made for the task.

The blind Inkscape build's capture was gone with its build computer, so the
bundle could not be exported again. Instead, a copy of that bundle had only
its `Launch` command replaced by the one this code renders for its seed (one
document, `Documents/poster.svg`; the image's `Exec=inkscape %F`). A computer
of it came up in 47 s with Inkscape showing `poster.svg` and no Welcome
screen, and `data/reset` relaunched it on the poster again. Three Claude Code
runs with Sonnet 5.5 all passed, in 11, 9 and 10 turns for $0.70, $0.46 and
$0.72 ($0.63 on average); the same bundle opening on the Welcome screen had
taken 18, 23 and 21 turns for $0.70, $1.55 and $0.51 ($0.92). Cache reads
fell from 585-714K tokens to 181-225K; the cost is mostly cache writes,
which varied from 17K to 189K tokens whatever the turns.

## Naming the app's state

Run on macOS with source tests and gates; no build computer was started.
Each test below failed on the head before this change, with only the tests
and their fixtures added, and passes now.

- `buildCaptureStatePathsMcp.test.ts`: `start_build_capture` with
  `state_paths` passes the note's path to the capture as `--state-path`, the
  draft covers it as a document with no notes, and an export with a check on
  it is accepted; without it the draft is empty with `unowned_changes`
  (the note, `unrelated`) and `no_document`, and the export's refusal names
  `state_paths`. A path through `..`, the home itself and 17 paths are
  refused by the schema, `/etc/hosts` by the computer, and none starts a
  capture. Before, `state_paths` was an unknown argument.
- `DesktopTaskDraftNotes.test.ts`: a draft with files has no notes; one with
  no change between seed and end has only `no_change`; one whose changes lie
  outside the owned paths lists five with their roles, desktop files last,
  and counts two more, beside `no_document`.
- `stateRoles.test.ts`: a selected file under a hidden folder of the home is
  application state, elsewhere a document.
- `DesktopApplicationExport.test.ts`, `appExportUnowned.test.ts`: the export's
  limitations and README name folders the capture saw change outside the
  owned paths, collapsed to their top folder and without desktop caches, up
  to eight and a count, and the seeded lock file, WebKit storage and cache
  folders.

## Lock files, changed files and held-open folders

Run on macOS with source tests and gates; no build computer was started. A
hold-out LibreOffice Calc bundle seeded `~/.config/libreoffice/4/.lock` and
showed no window at boot; its export also said nothing in `~/Documents` was
seeded while `seed_files` held `Documents/q1-sales.ods`. Each test below
failed on the head before this change, with only the tests and their
fixtures added, and passes now.

- `DesktopApplicationExport.test.ts`: a capture whose seed holds a profile
  `.lock` and a document lock `.~lock.today.txt#` exports without either in
  `seed_files` or the bundle, and lists both after "Left out of the seed" in
  one limitation and the README; with `~/Documents` held open, its
  limitation names `~/Documents/today.txt` as seeded from there.
- `appExportUnowned.test.ts`: profile, browser and document locks are lock
  files, and `*.lock` or `*.lck` only in a hidden folder, so `Cargo.lock`
  and `yarn.lock` in a project are not; the capture's limitation names the
  held-open folders from `~/`, and the export's names the seed files there
  or says there are none.
- `desktopCapture.test.ts`: a checkpoint's acknowledgement names its changed
  files home-relative, the held-open document first, then state, then the
  rest, without folders, and names ten of thirteen with three more.
- `buildCaptureMcp.test.ts`: `mark_build_checkpoint` returns the changed
  files the capture acknowledged.
- `buildComputerMcp.test.ts`: a bundle's start that never got ready names
  the lock files its seed holds; one without locks, or failing otherwise,
  names none.

The Linux-only capture test's acknowledgement now expects the changed state
file; it is skipped on macOS and was not run.

## Linked state paths, dconf changes, project lock files and older checkpoint replies

Run on macOS with source tests and gates; no build computer was started.
Each test below failed on the head before this change, with only the tests
and their fixtures added, and passes now.

- `buildCaptureStatePathsMcp.test.ts`: the computer refuses state paths that
  a link leads out of the home, existing or not yet (through the nearest
  existing folder, or a dangling link), or into `~/.rea-build`, and starts
  nothing; a link that stays in the home is followed and the path passed to
  the capture as named. Before, the first such path started a capture.
- `DesktopCaptureScope.test.ts`: the capture scope records each selected
  path as named beside the physical path it walks.
- `DesktopApplicationExport.test.ts`: with `~/.config/MuseScore` selected as
  a link to `~/settings/MuseScore` beside a selected note, the bundle's
  launch opens the note. With only the capture's record of selected paths
  added, the settings file was still a document and the launch opened none.
- `DesktopTaskDraftNotes.test.ts`: a draft whose only change between `seed`
  and `end` is to the app's keys in dconf carries `uncheckable_changes`
  naming `~/.config/dconf/user`, not `no_change`; one where only another
  group's keys changed still has `no_change`.
- `appExportUnowned.test.ts`: `*.lock` and `*.lck` are locks only directly
  in a state directory, so `Projects/.repo/Cargo.lock` is not; and 20,000
  separate unowned folders collapse in tens of milliseconds, where comparing
  every pair took 12.9 seconds.
- `DesktopApplicationExport.test.ts`: `Projects/.repo/Cargo.lock` and
  `.dotfiles/web/yarn.lock`, which the capture recognized as documents, and
  a lock-named file the caller selected are seeded, a `*.lock` directly in a
  state directory is left out, and the profile and document locks still are.
- `buildCaptureMcp.test.ts`: checkpoints acknowledged without
  `changed_files` and `more_changed_files`, as the previous REA in a build
  computer does, are taken with both `null`, also when a lost reply is read
  again from the capture's log. Before, the host refused the acknowledgement
  although the checkpoint was taken.
- `desktopCapture.test.ts`: a checkpoint's changed files name a document
  under a selected path first, though the app did not hold it open, and
  caches and browser-engine storage last, even one the app held open or in a
  state directory, so ten KDE service-cache files no longer push the saved
  document past the cut, as they did in a held-out Tellico build.
- `DesktopApplicationExport.test.ts`: with `~/.config/MuseScore` selected as
  a link to `~/Documents` and the note inside it selected itself, the
  launch opens the note while the settings beside it stay the app's; before,
  the link's hidden name made the note application state and the launch
  opened none.
- `DesktopTaskDraftNotes.test.ts`: a dconf database that changed but could
  not be read gives `unreadable_changes` with the reader's error, not
  `uncheckable_changes`.
- `buildCaptureMcp.test.ts`: `stop_build_capture` on a capture whose only
  change between `seed` and `end` is a dconf database the draft cannot read
  (no `dconf` on its `PATH`) returns the `unreadable_changes` note with its
  `error`; before, the build tool dropped the field.
- `LinuxApplicationInventory.test.ts`: the inventory lists KDE's
  `~/.config/<name>rc` before it exists, so a Tellico capture owns
  `~/.config/tellicorc`, whose absence brought back Tip of the Day at boot;
  `DesktopApplicationExport.test.ts` shows such a file, written during the
  capture, owned and seeded (that test passed before, given the inventory).

The capture's recording of selected paths runs only on Linux; its scope is
tested on macOS, and the capture itself was not run.

## GnuCash's dconf settings and book lock

Run on macOS with source tests and gates; no build computer was started, so
dconf-cli reading a real build computer's database is not verified here.
Each test below failed before the change and passes now.

- `appBuild.test.ts`, `buildComputerMcp.test.ts`: the build bundle installs
  `dconf-cli` beside `libgtk-3-bin`, read from the module the fake runner
  received.
- `desktopCaptureCli.test.ts`: a dconf database created before `seed` that
  the export cannot read (`REA_DCONF_COMMAND` names no program) leaves
  `DCONF = ""` and one limitation naming `~/.config/dconf/user` with the read
  error; exported with the seed at `baseline`, when it did not exist yet, no
  limitation names it.
- `appExportUnowned.test.ts`, `DesktopApplicationExport.test.ts`:
  `Documents/household.gnucash.LCK` beside `Documents/household.gnucash` is
  left out of the seed and listed after "Left out of the seed", in either
  letter case, while a lone `Documents/notes.lck` is seeded and a `.LCK` whose
  file lies in another folder is no lock.
- `buildComputerMcp.test.ts`: a bundle start that never got ready names a
  seeded `q1.ods.LCK` beside `q1.ods`, and not a lone `notes.lck`.

## Limits of this verification

- The witness acts were scripted by this agent from the task's prompt; no
  separate solving agent ran, and the exported `verify.py` was not run.
- Only the local provider on amd64, and only Mousepad.
