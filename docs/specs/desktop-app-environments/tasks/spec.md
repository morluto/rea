# Tasks for an exported desktop application

## Outcome

Each capture yields one agentenv task in its exported bundle. An agent writes
the task's prompt and declarative checks from the change the capture
recorded; REA validates the task against the capture and keeps it only if its
checks fail on the seed and pass on the captured end state. The bundle runs
the task with a computer-use agent and grades it with a verifier that reads
the app's `data/get` and evaluates the same checks. REA stays model-free and
never runs code the agent wrote.

## Requirements

- `rea describe-desktop-application-task CAPTURE` (CLI only) returns Evidence
  with operation `describe_desktop_application_task` and predicate type
  `rea.desktop-application-task-draft`: the environment name, title and window
  class; the export's owned paths; each file under them whose state differs
  between its first and last version, with role, both versions and the net
  change from `diffStateViews` (text listing each line once, plus the lines at
  both ends whose count changed); and a draft task with a placeholder prompt
  and checks suggested from the net change of documents, or of application
  state when no document changed. Views are shown only for those files, cut at
  200 items and 2,000 characters.
- The task file is JSON with a portable `name` other than `smoke`, a `prompt`
  and 1 to 32 `checks`, parsed by a zod schema in `src/domain/desktop/`. Check
  kinds: `file_present`, `file_absent`, `lines_present`, `lines_absent`,
  `line_count` (`exact` or `regex`; `equals`, `at_least` or `at_most`),
  `value_equals` and `value_absent` (RFC 6901 pointer), `row_present`,
  `row_absent` and `row_count` (SQLite table, `where` by column). Ids default
  to `check-N` and must be unique.
- Semantics: an absent file reads as empty; a file without a view fails every
  check but presence; line checks need a text view and row checks a SQLite
  view; JSON equality by value, never a boolean for a number; a regex matches
  anywhere with `.` matching any character; checks decided by what a view
  leaves out fail on a truncated view or table.
- Refusals, each naming the check: a file outside the owned paths or not
  spelled as a home path; the empty pointer; a pointer not starting with `/`,
  into text, or into XML using namespaces; a repeated line; a regex outside
  the portable subset (no escaped letters or digits, no `(?` other than `(?:`,
  no empty class, valid in JavaScript's `u` mode); a value that names the
  captured home or looks like an ISO 8601 date and time; the draft's
  placeholder prompt.
- `export-desktop-application --task FILE` evaluates the checks on the state
  view's first versions (the seed) and last versions (the end), refuses a
  task whose every check passes on the seed and a check that fails at the end,
  and refuses more than one task file. It writes `tasks/NAME.json` (deploy_env,
  deploy_agent, add_skills, start_computer_recording, prompt_agent,
  env_outcome_verifier, end_computer_recording),
  `artifacts/NAME-check/verify.py` and `evals/ENV.toml` naming the task, and a
  README section with the prompt, the checks and the solve-rate recipe.
- The verifier finds the app among the computer's child environments, calls
  its `data/get` and evaluates the checks in Python with the TypeScript
  evaluator's semantics, one result per check; it raises when the app cannot
  be reached.
- The product skill tells an agent how to describe the change, write the
  prompt and the checks, and export.

## Non-goals

- No REA command that runs agents or measures a solve rate; the user guide
  gives the `agent-env run` recipe.
- No checks over dconf keys, which `data/get` serves as binary, or over files
  outside the owned paths.
- No timestamp detection beyond ISO 8601 date-times; other volatile values
  are left to the author.
- No more than one task per capture.
