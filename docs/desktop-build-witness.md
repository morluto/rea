# Building and witnessing an environment

An agent such as Claude Code builds a desktop app environment from a request
on a [build computer](desktop-build-computer.md): it makes the seed through
the app, makes the change the task asks for, exports the bundle with the task
it writes, and then witnesses the task in a fresh computer of that bundle.
REA runs its own capture, task draft and export inside the build computer and
grades the witness with the same checks the exported verifier runs.

| Tool                       | What it does                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `start_build_capture`      | Downloads the package lists as the computer's user and launches the app under REA's capture |
| `mark_build_checkpoint`    | Takes a named checkpoint and returns the capture's acknowledgement with its counts          |
| `stop_build_capture`       | Stops the capture and returns its checkpoints and the task draft between `seed` and `end`   |
| `export_build_environment` | Exports the bundle with the agent's task inside the computer and copies it to a folder here |
| `check_build_task`         | Grades a task against the app's live state; with a `stage`, files the check in the witness  |

Like the computer tools, these are MCP-only and act on a `computer_id` from
`start_build_computer`.

REA's skill walks an agent from a request such as "build me an Inkscape
environment where the agent changes a poster's headline" to a witnessed
bundle with these tools: the questions it asks first, when it stops for the
person, the install, the seed, the task, the witness and its final report.
See [desktop builds](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/references/desktop-build.md).

## Build

1. `start_build_computer` from a request. REA is installed in the computer.
2. `start_build_capture`. REA first checks the installed runtime's export
   schema for synthetic-seed support. If the archive is too old, repack a
   current REA, update `REA_BUILD_COMPUTER_REA_ARCHIVE` and start a new build
   computer. REA then writes an apt configuration under
   `~/.rea-build/apt` and runs `apt-get update` as the computer's user, so the
   capture finds the package's sources (`package_lists` counts the lists,
   and `package_lists_error` gives apt's exit status and last lines when the
   download failed; a later start runs the update again until one succeeds). It then starts `rea capture-desktop-application
   --desktop-entry <entry>`
   in the computer, leaving `~/.rea-build` out of every checkpoint, and returns
   once the app's window is open, with a screenshot. For an app installed
   from a `.deb` file, the build layer keeps that file at
   `/opt/rea/package.deb` and the capture records it with `--package-file`. Do not open the app from
   the menu first: the capture refuses an app whose window is already open.
3. Make the seed through the app with `act_on_build_computer`, saving it
   where the user keeps such files, such as `~/Documents`, then
   `mark_build_checkpoint` `seed`.
4. Make the change the task will ask for, save it, and
   `mark_build_checkpoint` `end`.
5. `stop_build_capture`. The app is closed and the capture finishes. The
   result lists the checkpoints with their counts, the package and the
   sources the capture found, its limitations and the draft: each file that
   changed between `seed` and `end` with its net change, and suggested
   checks with a placeholder prompt.
6. Write the task: its name, the prompt in the user's own words, and checks
   that hold after the change and not on the seed.
7. `export_build_environment` with the task and a new or empty `directory`.
   The export runs inside the computer with `--seed-checkpoint seed
   --end-checkpoint end`, so it seeds what was saved at `seed`, scrubs the
   computer's host name and user from it, and refuses a task whose checks
   all pass on the seed. A task larger than 96 KiB as REA passes it to the
   computer is refused before anything runs. It also passes `--synthetic-seed`,
   since the agent made the seed for the task, so the README does not call it
   the user's real data. When the seed holds exactly one document and the
   app's desktop entry takes files, the bundle's app opens that document at
   launch. A file moved to the desktop Trash is not seeded, and the export's
   limitations name what the Trash held at `seed`. For a
   `.deb` app that no apt source the capture found offers, the export takes
   the request's URL with `--package-url`; one apt offers installs from apt. REA lists the bundle's files with their sizes
   and SHA-256 in the computer, into a file beside the bundle that it reads
   through `data/get`, since a large bundle's list outgrows a command's
   output; it then brings the files back through the driver's
   `data/get` in answers of at most 8 MiB, and checks and writes each answer
   into the folder before asking for the next, so one answer at a time is
   held; a failure leaves no partial folder.
8. `close_build_computer`.

A checkpoint name is lowercase letters, digits, dot, dash and underscore; the
capture's own `baseline`, `stop`, `time-limit` and `exit` are refused, and so
is a name already taken. The acknowledgement comes from the capture after it
has walked the home and retained what changed: `entries` walked, `changes`
since the checkpoint before, `retained_files` and `retained_bytes`.

Each step can be asked again after its answer was lost:

- A start whose answer is lost, or whose window never opened, stops the
  capture it may have left running. Until the computer confirms that stop,
  REA keeps the capture and the next `start_build_capture` retries the stop
  before starting another.
- A checkpoint the capture took whose acknowledgement was lost comes back
  from the capture's own log when the same name is marked again.
- A stop whose summary or draft was not read finishes when stop is asked
  again, and a finished stop repeats its result. The draft and the export
  trust the checkpoints the capture's own Evidence records.
- A step that saved something, such as an export's bundle or the witness's
  record, returns it even when its call is cancelled or the computer closes
  as the save finishes. `start_build_capture` saves nothing, so a close or
  cancellation during its screenshot of the opened app cancels it.

The capture, the draft and the export run as the computer's user in its home,
without any `AGENTENV_*` variable, so neither REA nor the app holds the
computer's control token. REA sends each command through agentenv's
`computer-exec/v1` route with that token, which stays in REA, and reads larger
outputs, such as the draft, the export's Evidence and the bundle's file
list, from files under `~/.rea-build` through `data/get`, since a command's
output is capped at 1 MiB.

Calls on one computer run one at a time, in the order REA receives them:
an action, a capture step, a check or a close waits until the call before
it on that computer has answered, and sends progress notifications while
it waits. So a check reads the app with no action half done, and a witness
stage is admitted, read and filed before anything else on that computer
runs. Calls on different computers run side by side. Closing a computer
cancels the call in progress on it and refuses the calls still waiting.

## Witness

Start a fresh computer from the exported folder with `start_build_computer`
and `{"kind": "bundle", "path": ...}`; agentenv boots the app with the seed,
on the seed's document when the export opens one.
Then, with the task exactly as exported:

| `stage`       | Before it                                                         | Its checks must              |
| ------------- | ----------------------------------------------------------------- | ---------------------------- |
| `seed`        | nothing; give `directory`, a new or empty folder for the record   | fail at least once           |
| `after_edit`  | the task done through the app from its prompt alone               | all pass                     |
| `near_miss`   | a change that is almost right, such as a misspelled line          | fail at least once           |
| `after_reset` | `act_on_build_computer` with `action: "reset"` as the last change | each come out as on the seed |

`check_build_task` reads the app's `data/get`, takes the views it returns
beside the files and evaluates each check with REA's evaluator, the one the
export validates tasks with and the exported verifier mirrors, one result per
check. Without `stage` it only grades. The `seed` stage begins a recording
of the display under REA's own request id, one per computer; a seed check
that fails after it, such as on a failed read of the app's state or a lost
reply to the recording's start, can be asked again, and asks for the
recording under the same id, which the computer answers with the recording
it already began. The stages come in order. The edit and the near miss each
need an applied click, drag, scroll, type or key since the stage before, with
no reset after the last of them, since a reset puts the seed back rather than
changing the app; `after_reset` needs the reset as the last change, and a
reset that leaves any check unlike on the seed fails the witness, its
stage's `remediation` naming those checks. On a computer started from a
bundle folder, the seed refuses a task whose `tasks/<name>.json` or verifier
in the bundle differs from what the export writes for it. A reset
relaunches the app, and REA waits until the computer is ready again before
answering, sending progress notifications while it waits.

Only a check that fails on what the app's view shows counts as a failure. A
check that fails because its file or table could not be read, such as an
SQLite file locked past the reader's wait, or because what it looks for may
lie in what its view cut, is `undecided` in its result: it shows nothing
about the task. That covers a line `lines_present` misses in a text view cut
at 5,000 lines, a row `row_present` misses in a table whose view keeps only
its first rows, a `value_equals` or text check pointer that names nothing
in a truncated view or past a cut zip listing, the absence checks and counts
on a cut view, and `text_equals` or `text_contains` of an element on one,
even where the element's kept text holds the value, since the cut may have
dropped text from between its runs. Any other check that passes on what the
view kept stays decided, and so does a value found there that differs from
the one expected.
The result's `passed` and description are the exported verifier's, which has
no undecided results. A stage that only undecided checks would settle, such
as a near miss whose one failing check could not read its file, files nothing
and is refused; check it again once the files read whole.

A stage whose checks do not show what it must ends the witness, and so does
`after_reset`. REA then ends the recording, fetches its segments through
`data/get`, each checked against the recording's manifest, and writes into
`directory`:

- `recording/NNNN.mp4`, the recording's segments;
- `witness.json`, REA Evidence (`rea.desktop-build-witness`) holding the
  verdict, the stage that failed if one did, the task's name and SHA-256,
  each stage's results with how many logged actions came before it, the
  computer's [action log](desktop-build-computer.md#act) as it keeps it, each
  action with its arguments, timing and outcome, with `actions_dropped`
  counting the earliest actions it no longer keeps, and the recording's
  segments with their sizes and SHA-256. The record's limitations say when
  the log dropped actions or cut arguments, which each entry names in
  `truncated_arguments`.

The stages' rules read the log's count of actions and the last applied
action of each kind, which it keeps for the whole session, so they hold
however many entries it dropped. The result returns the same record. When writing it fails, such as for a
folder something else wrote into, the witness keeps its stages: check the
stage that ended it again, with the same task, and REA writes the record
without checking again. Once it is saved, the same check returns the saved
record again, so a record saved as its call was cancelled is not lost. A
computer is witnessed once; witness again from a fresh computer.

See the [specification](specs/desktop-app-environments/build-witness/spec.md)
for scope and verification.
