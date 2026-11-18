# Verification

Run on 2026-11-06 on top of the readers commit, on macOS with Node v22.23.1
and Python 3, and on an arm64 Ubuntu 24.04 build host with
agentenv-framework 0.9.1431.

## Tests

- `src/domain/desktop/appTaskScreen.test.ts`: the parser keeps a task of
  screen judges and refuses one beside a file check, with readers, with a
  blank question or with a `file`; REA's evaluator leaves a screen judge
  undecided; the rendered verifier screenshots the computer, names the
  judge's role, default model and votes, says `--judge-model` does not reach
  it, and holds the examples `screenExamplesOf` reads back; `readableChanges`
  counts only changes a check could read.
- `tests/boundary/providers/desktopScreenJudgePython.test.ts`: the verifier,
  run with stand-ins for the MCP client, litellm and agentenv's config,
  takes one screenshot, asks three votes each showing the seed's and the
  end's examples before the screenshot, passes on two yes and fails on two
  no, asks the `[model.roles] judge` model, asks a failed call again, raises
  when no vote answers or no endpoint is set, and judges a given screenshot
  when run as a script.
- `src/application/desktop/DesktopTaskExport.test.ts`: the export ships the
  seed's and the end's screenshots in order with an empty `failing_on_seed`
  and the witness limitation, and refuses a task whose capture shows a
  readable file change or lacks a screenshot.
- `tests/boundary/mcp/buildCaptureMcp.test.ts`: marking `seed` and `end`
  writes `screens/seed.jpg` and `screens/end.jpg` in the computer, and the
  export is given `--screens`.
- `tests/boundary/mcp/buildWitnessMcp.test.ts`: a screen-judged witness runs
  the bundle's verifier with the runner's Python at each stage, three votes a
  stage, each with three images, and holds.
- `src/domain/desktop/appExport.test.ts`: an app owning no files gets a
  relaunch-only reset only for a screen-judged task.
- `src/application/DesktopBuildDoctor.test.ts`: the endpoint check names
  screen judges.

Each failed on the readers commit before the change.

## Real app

GNOME Calculator 46.3 on the arm64 host. The capture's draft noted
`no_change` and `no_document`. The task `tip-amount` asks to work out 18% of
47.60 and leave the result showing, with one question, "Does the
calculator's display show the result 8.568?". The export kept it in 1.8 s
with the 39 KB seed and 41 KB end screenshots as examples, and gave the app,
which owns no files, a relaunch-only reset.

| Stage         | Screen                           | Judge       | Held | Time   |
| ------------- | -------------------------------- | ----------- | ---- | ------ |
| `seed`        | empty display                    | no, 3 of 3  | yes  | 10.7 s |
| `after_edit`  | 47.6×0.18 = 8.568                | yes, 3 of 3 | yes  | 9.7 s  |
| `near_miss`   | 47.6×0.17 = 8.092                | no, 3 of 3  | yes  | 9.7 s  |
| `after_reset` | empty display after the relaunch | no, 3 of 3  | yes  | 9.8 s  |

Three solves with Claude Code on Claude Sonnet 5.5 all passed, the judge
saying yes in 3 of 3 votes each time; the verifier step took 8.1 to 9.1 s and
the solves cost $1.72, besides about $0.02 of judge calls per grade.
