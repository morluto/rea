# Verification

Run on 2026-11-06 on top of the integration of the desktop build stack, on
macOS with Node v22.23.1 and Python 3, and on an arm64 Ubuntu 24.04 build
host with agentenv-framework 0.9.1431.

## Tests

- `src/domain/desktop/appTaskReaders.test.ts`: the parser keeps readers and
  refuses an undefined reader, a check whose file is not its reader's, a
  reader naming no `{file}`, repeated ids, an unread reader, a reader file
  with a leading slash, a kind its output does not serve and a text check
  with a reader; the evaluator reads a check through its reader rather than
  the file's binary view, fails it undecided with the reader's error, and
  as decided on an absent file; the runner's command and answers.
- `tests/boundary/providers/desktopTaskReaderRunner.test.ts`: the runner,
  run with `python3` as computer-exec runs it, gives the reader a private
  copy in a fresh home without `DISPLAY`, the session bus or the control
  token, keeps the display only when asked, reads a path in place of the
  home's file, keeps only marked lines, answers absent without running the
  reader, reports a non-zero exit, no marked line, a view that is not JSON,
  an inexact number, more than 1 MiB and a command that cannot start, and
  kills a reader and what it started past its timeout.
- `tests/boundary/providers/desktopTaskPython.test.ts`: the exported
  verifier runs each reader through `computer-exec/v1` with the runner's
  command, a fresh request id and the reader's timeout plus 30 s, grades
  every reader check as REA's evaluator does, with the same descriptions, and
  raises when the computer offers no `computer-exec/v1` or the runner does
  not answer.
- `src/application/desktop/DesktopTaskExport.test.ts`: the export runs a
  reader on the seed as shipped and on the end, keeps the task and ships the
  reader in the verifier and the README; it refuses a check that fails on
  the end with what the reader printed, a reader that exits non-zero with
  its error, a task that already passes on the seed and a reader outside
  the owned paths.
- `tests/boundary/mcp/buildWitnessMcp.test.ts`: a witness of a task whose
  check reads a binary file through a reader, run by the fake computer's
  computer-exec, holds at all four stages and returns no control token.
- `src/domain/desktop/appTaskDraftFileNotes.test.ts`: a binary file's draft
  note points at readers.
- `src/domain/desktop/appTaskReaders.test.ts` also pins the SHA-256 of a
  reader-less task's verifier as the tree before readers renders it,
  `91821c46…`; the rendering with `evaluate`'s reader argument failed it.

Each failed on the unchanged code: the reader module did not exist, the
schema refused `reader` and `readers`, and the note named no reader.

## Real apps

On the arm64 host, each through `start_build_computer`, the app's own
interface, `start_build_capture`, `seed` and `end` checkpoints,
`stop_build_capture` (whose draft noted the file as `unreadable_view` and
pointed at readers), `export_build_environment` and a witness in a fresh
computer of the bundle:

| App           | Document                | Task                                  | Reader                                  | Export                            | Witness                      |
| ------------- | ----------------------- | ------------------------------------- | --------------------------------------- | --------------------------------- | ---------------------------- |
| GIMP 2.10.36  | `Documents/poster.xcf`  | rename the Headline layer Summer Sale | Script-Fu through `gimp-console-2.10`   | kept; 2 of 3 checks fail on seed  | held; each stage about 5.6 s |
| Blender 4.0.2 | `Documents/scene.blend` | move the Crate to x = 2 m             | `blender -b --factory-startup` with bpy | kept; 1 of 3 checks fails on seed | held; each stage about 4.4 s |

A stage's time is the 3 s the app's files must hold plus the reader: about
2.5 s for GIMP and 1.4 s for Blender. The near misses were Summer Sail and
x = 2.5 m.

Then three solves of each bundle with Claude Code on Claude Sonnet 5.5,
through `agent-env run`, each graded by the exported verifier, which ran the
reader through the computer's `computer-exec/v1`:

| Task                    | Passed | Verifier step | Cost  |
| ----------------------- | ------ | ------------- | ----- |
| `rename-headline-layer` | 3 of 3 | 5.6 to 5.7 s  | $1.94 |
| `move-crate`            | 3 of 3 | 4.5 s         | $2.31 |

Blender 4.0.2 writes its preferences only when they are saved, so its seed
held no `userpref.blend` and every boot showed the Quick Setup splash, which
the witness dismissed with Continue; the solves passed with it there. The
build skill now saves Blender's preferences before `seed`.
