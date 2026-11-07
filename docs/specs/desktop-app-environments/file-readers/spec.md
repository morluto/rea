# Readers: checking files REA cannot read

## Outcome

A task can check a file REA reads as binary, such as GIMP's `.xcf` or
Blender's `.blend`, through a reader: the app's own headless command, run in
the computer on a private copy of the file, whose marked output becomes a
view that the existing check kinds read. The export validates such checks on
the seed and the end, the witness checks them live, and the exported verifier
grades them in the solving agent's computer, all through one runner.

## Requirements

- Task file: an optional `readers` array of 1 to 8
  `{id, file, argv, stdin?, output, timeout_s?, display?}`. `id` is lowercase
  letters, digits and hyphens and unique; `file` is a path under the home;
  `argv` holds 1 to 64 non-empty strings; `stdin` at most 64 KiB; `output`
  is `json` or `lines`; `timeout_s` is 1 to 300, 60 when omitted; `display`
  is false when omitted. The argv or the stdin names the file as `{file}`.
- Checks: `lines_present`, `lines_absent` and `line_count` take an optional
  `reader` naming a `lines` reader; `value_equals`, `value_absent` and
  `member_count` one naming a `json` reader. The check's `file` is the
  reader's. Other kinds take none. Every reader is read by a check. The parser
  refuses each breach with the check or reader it names.
- Runner: one Python program, embedded in REA and in each verifier that needs
  it, run as `python3 -I -c <runner> <arguments>` in the computer's session.
  It answers with one JSON line: `{"view"}`, `{"absent": true}` when the file
  is not there, or `{"error"}`. It copies the file into a new temporary folder,
  runs the command there with `{file}` replaced by the copy's path in argv and
  stdin, `HOME` and the four `XDG_` folders in that folder, without
  `DISPLAY`, `WAYLAND_DISPLAY` or `XAUTHORITY` unless `display` is true, and
  never with `DBUS_SESSION_BUS_ADDRESS`, `SESSION_MANAGER`,
  `XDG_RUNTIME_DIR` or any `AGENTENV_` variable. Past `timeout_s` it kills
  the command's whole session. It deletes the folder afterwards.
- View: each output line starting with `REA ` is a line of the view, without
  the marker. A `lines` reader's view is a text view (`lines`, `line_count`,
  `truncated` past 5,000 lines); a `json` reader's is the marked lines joined
  by line feeds, read as one JSON value, refusing NaN, infinities and
  integers past 2^53. A command that cannot start, exits other than 0, runs
  past its timeout, prints more than 1 MiB, prints no marked line or prints a
  `json` view that does not parse gives an error view, with the last 1 KiB of
  its stderr; so does an answer past 960 KiB.
- Evaluators: REA's and the verifier's read a check with `reader` from the
  reader's view, by id, instead of the file's. A missing reader view reads as
  an absent file; an error view fails the check as undecided, worded as an
  unreadable file's, in both.
- Export: the export runs each reader on this host, in the build computer,
  on the file's bytes at the seed as the bundle ships them and at the end
  checkpoint as retained; a file not retained at the end gives an error view.
  It refuses a reader of a file outside the owned paths or naming the
  captured home or the host's identity. A check through a reader that fails
  on the end adds what the reader printed to the refusal.
- Witness: once the app's files settle, `check_build_task` runs the readers
  through the computer's `computer-exec/v1`, and a runner that does not
  answer fails the check call as a failed read of the app's state.
- Verifier: a task with readers holds the runner once and each reader's
  arguments; after its files settle it runs each through `computer-exec/v1`
  under the run's grant, with a request id of its own and the reader's
  timeout plus 30 s, and raises when the computer offers no such route or
  the runner does not answer, so the run fails rather than scoring the agent.
  It grades through `evaluate_with_readers`, which only such a verifier holds:
  a task without readers renders the verifier byte for byte as before, so a
  bundle exported earlier witnesses as the same task.
- Draft: a file REA reads as binary is noted as checkable through a reader.

## Non-goals

- Drafting checks from a reader's output: the building agent writes the
  reader and its checks; the export's refusals show what it read.
- XML output from a reader, and text checks through one.
- Shipping readers maintained by REA for known formats; the skill gives
  recipes.
- A screen judge for state no file holds; that is the next step.
