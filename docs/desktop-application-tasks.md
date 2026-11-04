# Desktop application tasks

A [desktop application export](desktop-application-export.md) can carry one
task: a prompt for a computer-use agent and checks that grade what the agent
left in the application's files. An agent, not REA, writes the prompt and the
checks from the change the capture recorded. REA validates the task against
the capture and keeps it only when its checks fail on the seed and all pass on
the captured end state. REA runs no model and no code the agent wrote: the
checks are declarative, and the exported verifier evaluates them the same way
REA does.

```sh
rea describe-desktop-application-task ./mousepad-capture --format json > draft.json
# edit the draft's task into task.json: a name, the user's request, the checks
rea export-desktop-application ./mousepad-capture ./mousepad-bundle --task task.json
agent-env run ./mousepad-bundle --task add-milk --agent claude-code
```

## Describe the change

`rea describe-desktop-application-task <capture-folder>` reads the capture and
its [state view](desktop-application-state.md) and returns Evidence with
operation `describe_desktop_application_task` and predicate type
`rea.desktop-application-task-draft`:

- `application`: the environment name the export would use, the title and the
  window class.
- `owned_paths`: the paths the export owns, the only ones whose files the
  app's `data/get` serves and checks can read.
- `files`: each file under them whose state differs between the capture's
  first and last version, with its home path, role, both versions and the net
  change between them, from the state view's own diff (`lines`, `values`,
  `keys` or `rows` with what was added, removed and changed, or `created`,
  `deleted`, `format`, `content`, `unreadable`). Text changes list each line
  once and add `line_counts`, the lines found at both ends whose number of
  occurrences changed. Views appear only for the files the suggestions cover,
  with arrays past 200 items and strings past 2,000 characters cut
  (`view_cut`).
- `task`: a draft with the name `change`, a placeholder prompt the export
  refuses, and suggested checks derived from the net change of the files with
  role `document`, or of the app's own state files when no document changed.
  A text file gains `lines_present` for its new lines and `lines_absent` for
  lines it lost (when either is at most ten), and `line_count` for each line
  holding a letter whose count changed; JSON, XML and key files gain
  `value_equals` and `value_absent` by pointer; SQLite tables gain rows added,
  changed and removed, by primary key, and their new row count. Values that
  look like a time the app stamps are left out.

The suggestions are a starting point. Keep the ones that say what the user
did; drop the ones that only follow from how the app saves its file. A LibreCAD
capture that added four holes to a drawing rewrote it from DXF R12 to DXF 2007,
so most of its lines changed; the draft suggests counts of `SECTION`, `ENDSEC`
and `CIRCLE`, and only `CIRCLE` going from 5 to 9 is the user's change.

## The task file

```json
{
  "name": "add-milk",
  "prompt": "Add buy milk to my to-do list in Mousepad and save it.",
  "checks": [
    {
      "id": "milk",
      "kind": "lines_present",
      "file": "Documents/todo.txt",
      "lines": ["buy milk"]
    }
  ]
}
```

`name` is a portable bundle name other than `smoke` (lowercase letters, digits
and hyphens); `prompt` is what the user asks for; `checks` holds 1 to 32
checks. Each check has a `kind`, a `file` given as a path under the home such as
`Documents/todo.txt`, and an optional `id` (`check-1`, `check-2` and so on by
position otherwise). A check reads the typed view `data/get` returns for that
file, in the shapes of the state view.

| Kind            | Fields                                                       | Passes when                                                              |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `file_present`  |                                                              | The file exists                                                          |
| `file_absent`   |                                                              | The file does not exist                                                  |
| `lines_present` | `lines`                                                      | Every listed line is a whole line of the text view                       |
| `lines_absent`  | `lines`                                                      | None of the listed lines is                                              |
| `line_count`    | `exact` or `regex`; `equals`, `at_least` or `at_most`        | The number of lines equal to `exact`, or matched by `regex`, compares so |
| `value_equals`  | `pointer`, `value`                                           | The JSON pointer names a value equal to `value`                          |
| `value_absent`  | `pointer`                                                    | The pointer names no value                                               |
| `row_present`   | `table`, `where`                                             | A row of the SQLite table has every column in `where` equal              |
| `row_absent`    | `table`, `where`                                             | No row does                                                              |
| `row_count`     | `table`; optional `where`; `equals`, `at_least` or `at_most` | The number of rows, or of rows matching `where`, compares so             |

The rules both evaluators follow:

- An absent file reads as empty: no lines, values or rows. So `lines_absent`,
  `value_absent` and `row_absent` pass on it and a count is 0.
- A file that has no view (binary, over the read limit, or unreadable) fails
  every check but `file_present` and `file_absent`. Line checks need a text
  view and row checks a SQLite view; another format fails.
- Equality is JSON equality: numbers by value, never a boolean for a number,
  objects by their keys whatever their order, arrays in order.
- Pointers follow RFC 6901 (`~1` for `/`, `~0` for `~`) and must start with
  `/`. Key files read as `{"groups": {"GROUP": {"KEY": "VALUE"}}}`, so a
  setting is `/groups/GROUP/KEY`; XML as
  `{"root": {"name", "attributes", "children"}}`; SQLite as `{"tables": {"TABLE": {"columns", "rows"}}}`.
- A regular expression matches anywhere in a line, with `.` matching any
  character. It must stay in the subset JavaScript and Python read alike: no
  escaped letters or digits (write `[0-9]` for a digit), no `(?` group other
  than `(?:`, and no empty class.
- A check decided by what a view leaves out (`lines_absent`, `value_absent`,
  `row_absent` and the counts) fails when that view, or that table, is
  truncated; a check satisfied by what the view holds is decided on it.

The export refuses, naming the check, a file outside the owned paths, a file
spelled with a leading slash, `.` or `..`, a pointer into a text file or into
XML that uses namespaces (the verifier's reader names them differently), the
empty pointer (the whole file), a value that names the captured home, and a
value that looks like an ISO 8601 date and time. Other volatile content, such
as a counter the app bumps on every save, is for the author to leave out.

## Validation and export

`rea export-desktop-application <capture> <directory> --task <task.json>`
evaluates the checks on the capture's state view: on the first version of
each file, which is the seed, and on its last version, the captured end state.
It refuses a task whose every check passes on the seed, and a check that fails
on the end state, with that check's reason. A capture yields one task, so the
option is taken once. The result's `task` names the task, its number of checks
and those that fail on the seed. A refused task writes no bundle.

The bundle then holds, besides the app and `tasks/smoke.json`:

| Path                               | Contents                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `tasks/<name>.json`                | Deploy the app, deploy the agent and its skills, record the screen, prompt the agent, run the verifier, stop recording |
| `artifacts/<name>-check/verify.py` | Reads the app's `data/get` through the computer and evaluates the checks, one result per check                         |
| `evals/<env>.toml`                 | The task, so a run of the bundle runs it; the smoke task runs with `--task smoke`                                      |

The verifier finds the app among the computer's child environments, calls its
`data/get` under the run's grant of the computer's control token, and reads
the `state` data part. It raises when the app cannot be reached, so the run
fails rather than scoring the agent. The README lists the task, its prompt, its
checks and the recipe below.

## Solve rate

REA does not run agents. To measure how often an agent solves the task, run it
k times, three by default, and count the runs whose summary line says
`passed`:

```sh
for run in 1 2 3; do
  agent-env run ./mousepad-bundle --task add-milk --agent claude-code --model MODEL
done
```

The agent defaults to Claude Code and the model is the caller's choice (Claude
Sonnet 5.5 is a reasonable reference). A run reported as `scored below 1`
failed the checks and counts as a miss; one reported as `failed` did not finish,
as when the computer or the app could not be reached, and is run again rather
than counted. Each run's instance keeps the verifier's results per check under
`verifications`.
