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

## Build

1. `start_build_computer` from a request. REA is installed in the computer.
2. `start_build_capture`. REA writes an apt configuration under
   `~/.rea-build/apt` and runs `apt-get update` as the computer's user, so the
   capture finds the package's sources (`package_lists` counts the lists).
   It then starts `rea capture-desktop-application --desktop-entry <entry>`
   in the computer, leaving `~/.rea-build` out of every checkpoint, and returns
   once the app's window is open, with a screenshot. Do not open the app from
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
   all pass on the seed. REA lists the bundle's files with their sizes and
   SHA-256 in the computer, brings them back through the driver's `data/get`
   in answers of at most 8 MiB, checks each, and writes the folder.
8. `close_build_computer`.

A checkpoint name is lowercase letters, digits, dot, dash and underscore; the
capture's own `baseline`, `stop`, `time-limit` and `exit` are refused, and so
is a name already taken. The acknowledgement comes from the capture after it
has walked the home and retained what changed: `entries` walked, `changes`
since the checkpoint before, `retained_files` and `retained_bytes`.

The capture, the draft and the export run as the computer's user in its home,
without any `AGENTENV_*` variable, so neither REA nor the app holds the
computer's control token. REA sends each command through agentenv's
`computer-exec/v1` route with that token, which stays in REA, and reads larger
outputs, such as the draft and the export's Evidence, from files under
`~/.rea-build` through `data/get`, since a command's output is capped at
1 MiB.

## Witness

Start a fresh computer from the exported folder with `start_build_computer`
and `{"kind": "bundle", "path": ...}`; agentenv boots the app with the seed.
Then, with the task exactly as exported:

| `stage`       | Before it                                                         | Its checks must          |
| ------------- | ----------------------------------------------------------------- | ------------------------ |
| `seed`        | nothing; give `directory`, a new or empty folder for the record   | fail at least once       |
| `after_edit`  | the task done through the app from its prompt alone               | all pass                 |
| `near_miss`   | a change that is almost right, such as a misspelled line          | fail at least once       |
| `after_reset` | `act_on_build_computer` with `action: "reset"` as the last change | fail at least once again |

`check_build_task` reads the app's `data/get`, takes the views it returns
beside the files and evaluates each check with REA's evaluator, the one the
export validates tasks with and the exported verifier mirrors, one result per
check. Without `stage` it only grades. The `seed` stage begins a recording
of the display under REA's own request id. The stages come in order; the edit
and the near miss each need an applied click, drag, scroll, type or key since
the stage before, and `after_reset` needs the reset as the last change. A
reset relaunches the app, and REA waits until the computer is ready again
before answering.

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
however many entries it dropped. The result returns the same record. A
computer is witnessed once; witness again from a fresh computer.

See the [specification](specs/desktop-app-environments/build-witness/spec.md)
for scope and verification.
