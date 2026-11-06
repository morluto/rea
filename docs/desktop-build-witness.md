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
| `mark_build_checkpoint`    | Takes a named checkpoint and returns the capture's counts and the files that changed        |
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
2. `start_build_capture`. REA writes an apt configuration under
   `~/.rea-build/apt` and runs `apt-get update` as the computer's user, so the
   capture finds the package's sources (`package_lists` counts the lists,
   and `package_lists_error` gives apt's exit status and last lines when the
   download failed). It then starts `rea capture-desktop-application
   --desktop-entry <entry>`
   in the computer, leaving `~/.rea-build` out of every checkpoint, and returns
   once the app's window is open, with a screenshot. For an app installed
   from a `.deb` file, the build layer keeps that file at
   `/opt/rea/package.deb` and the capture records it with `--package-file`. Do not open the app from
   the menu first: the capture refuses an app whose window is already open.
   When the capture ends before the window opens, REA reads its output. An app
   that exits at launch, such as one missing a runtime, is reported with its
   program, exit code, run time and the last lines of its stderr, at most 8
   lines and 800 characters of the last 8 KiB the capture keeps, and
   `details.diagnostics` keeps the capture's record of the session. A capture
   that failed, such as one refusing to start, gives its own message and
   remediation, with the whole failure in `details.diagnostics.command_failure`
   and, when its cleanup is incomplete, the run tokens and paths it left in
   `details.resources`. A checkpoint or stop that finds the capture ended
   reads its output the same way.

   `state_paths` names files or folders in the computer's home that hold the
   app's state, relative to the home, after `~/` or absolute under it, at
   most 16; each becomes a `--state-path` of the capture, so it is retained
   from the start and its files count as the app's even before they exist.
   REA counts a file as a document only when an app window's title shows its
   name or `~/` path, so name the file the app will save when its title shows
   something else, as MuseScore's shows a score's title: a file outside
   hidden folders becomes a document, which the bundle owns, seeds and opens
   at launch, and one under a hidden folder such as `~/.config/MuseScore` the
   app's own state. A path with `..`, or naming the home itself, is refused
   before the computer is asked; the computer refuses an absolute path
   outside its home, or in `~/.rea-build`, and starts nothing.

3. Make the seed through the app with `act_on_build_computer`, saving it
   where the user keeps such files, such as `~/Documents`, then
   `mark_build_checkpoint` `seed`.
4. Make the change the task will ask for, save it, and
   `mark_build_checkpoint` `end`.
5. `stop_build_capture`. The app is closed and the capture finishes. The
   result lists the checkpoints with their counts, the package and the
   sources the capture found, its limitations and the draft: each file under
   the paths the export owns that changed between `seed` and `end`, with its
   net change and, for XML files, archives, JSON and key files, its `values`,
   the values the change added, changed and removed with what each was and
   became, at the pointer a check names it by; suggested checks with a
   placeholder prompt; and `guards`, optional checks that the rest kept its
   seed values. The draft's
   [task section](desktop-application-tasks.md#describe-the-change) describes
   each. `notes`, each with a `code` and a `message`, say why a draft has no
   files: `no_change` when no file under the home changed between them;
   `unowned_changes` when files changed but none under the owned paths,
   listing up to five in `files` with their roles, desktop files last, and
   counting the rest in `more`; and `no_document` when no file has the
   document role. The last two point at `state_paths`. They also say, for
   a drafted `file`, why its suggestions are thin: `by_position`,
   `view_state_only`, `long_text`, `cut_view` or `unreadable_view`.
6. Write the task: its name, the prompt in the user's own words, and checks
   that hold after the change and not on the seed, from the suggestions,
   `values` and any `guards` worth keeping.
7. `export_build_environment` with the task and a new or empty `directory`.
   The export runs inside the computer with `--seed-checkpoint seed
   --end-checkpoint end`, so it seeds what was saved at `seed`, scrubs the
   computer's host name and user from it, and refuses a task whose checks
   all pass on the seed. It also passes `--synthetic-seed`, since the agent
   made the seed for the task, so the README does not call it the user's real
   data. When the seed holds exactly one document and the app's desktop entry
   takes files, the bundle's app opens that document at launch. A file moved
   to the desktop Trash is not seeded, and the export's limitations name what
   the Trash held at `seed`. The limitations and the README also name the
   folders where files changed during the capture that the bundle neither
   owns nor seeds, such as settings that keep a first-run wizard away, up to
   eight collapsed to their top folder, such as `~/.config/MuseScore`, and a
   count of the rest; capture again with them in `state_paths` to own them.
   Lock files the app holds while it runs, such as LibreOffice's profile
   `.lock` and its document lock `.~lock.<name>#`, are left out of the seed,
   since a copied one can keep the app from starting, and the limitations
   and the README list them after "Left out of the seed". They name seeded
   WebKit or Chromium storage and caches too, which the app keeps for its
   own running. When the application held files open in a folder whose
   starting content the capture did not retain, a limitation names the
   folder and the seed files in it. For a
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
since the checkpoint before, `retained_files` and `retained_bytes`, and up to
ten `changed_files`, home-relative, with `more_changed_files` counting the
rest. Folders are left out, and files the app held open come first, then
those in its state directories, then the rest, each by path, so a save's
document leads the list.

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
output is capped at 1 MiB. In a command's Evidence or failure read this way,
as in its own output, REA replaces the token in every string, after checking
the Evidence's digest; the bundle's files arrive as they are.

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
on the seed's document when the export opens one. When the computer never
gets ready and the bundle's seed holds lock files, the start's error names
them: delete them from the bundle, or export again, which leaves them out.
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
check. Like the verifier, it grades only once the app's files settle, since an
app such as Gnote saves a few seconds after the last key. It reads `data/get`
every 0.5 s and grades once every file's bytes have held for 3 s, counted
from the read that returned them. 15 s after the first read began, it grades
the last completed read: no read starts then, and one still running is cut.
It sends progress notifications while it waits. The result's `settled` says
whether the files settled, and `read_cut` whether the bound cut a read; each
stage in the record keeps both. Every check therefore costs at least 3 s,
and a save that lands more than 3 s after the first read returns is still
missed; see
[grading once the app has saved](desktop-application-export.md#grading-once-the-app-has-saved).
Without `stage` it only grades. The `seed` stage begins a recording
of the display under REA's own request id, one per computer; a seed check
that fails after it, such as on a failed read of the app's state or a lost
reply to the recording's start, can be asked again, and asks for the
recording under the same id, which the computer answers with the recording
it already began. The stages come in order. The edit and the near miss each
need an applied click, drag, scroll, type or key since the stage before, with
no reset after the last of them, since a reset puts the seed back rather than
changing the app; `after_reset` needs the reset as the last change. A reset
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
  each stage's results with how many logged actions came before it and
  whether the app's files had settled (`settled`), the
  computer's [action log](desktop-build-computer.md#act) as it keeps it, each
  action with its arguments, timing and outcome, with `actions_dropped`
  counting the earliest actions it no longer keeps, and the recording's
  segments with their sizes and SHA-256. The record's limitations say when
  the log dropped actions or cut arguments, which each entry names in
  `truncated_arguments`, and which stages graded files that had not settled.

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
