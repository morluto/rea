# Verification

Run on 2026-11-04 on top of the vendor packages branch (`7a6ac88ab`): gates
and source tests on macOS with Node v22.23.1 and Python 3.11; Linux tests in
the `rea-desktop-e2e` Ubuntu 24.04 arm64 container with Node v24.22.1 and
Python 3.12.3; agentenv-framework 0.9.1431 from the runner virtual
environment, with local Docker for the computer run.

## Gates

- `npm run typecheck`, `lint`, `lint:typed`, `format:check`, `build:cached`
  then `knip`, `jscpd`, `docs:check`, `verify:test-discovery` and
  `verify:architecture-guards`: passed, with no lint, typed-lint or
  duplication findings in the new or touched files.
- `docs:build`: passed, including the new guide and this step's spec pages.
- `npx vitest run src/domain/desktop src/application/desktop src/desktop`:
  258 passed and 14 skipped on macOS; with the two Python boundary tests, 273
  passed and 1 skipped in the container.
- CLI boundary tests `cliInputSchemaRequired`, `cliToolCoverage` and
  `cliStartupImports`, `setupSkill`, and the Python boundary tests
  `desktopExportPython` and `desktopTaskPython` (macOS and container): passed.
- New tests: 64 checks covering every kind against views of every format
  (text, a truncated text view, JSON with numbers, booleans, arrays and
  escaped pointers, a key file, a truncated XML view, SQLite with a truncated
  and an unreadable table and a database whose tables were cut, binary, a
  view error, an absent file), asserted for the TypeScript evaluator and for
  the rendered `verify.py` under `python3 -I` with a stub protocol client,
  which agree on every result and description and call the app at
  `/svc/notes`; 22 task refusals; suggestions for text, a format rewrite, key
  files, SQLite rows and created and deleted files; the export with a task
  and eight refusals, none writing a bundle; and a draft the export accepts.

## Real captures

- Mousepad (`~/Documents/todo.txt`, "buy bread" then "buy bread" and "buy
  milk"): the draft lists `Documents/todo.txt` (document, `lines`, added "buy
  milk") and `.config/Mousepad/accels.scm` (application state, created, no
  view), and suggests `lines_present` "buy milk". A task with that check and
  "buy bread" kept was exported; its checks fail on the seed (`milk-listed`)
  and pass at the end. A task checking only "buy bread" was refused as
  passing on the seed, one checking "buy eggs" as failing at the end, and two
  `--task` flags as more than one task. agentenv's dry run planned the task,
  the verifier artifact and the eval, leaving the smoke task to
  `--task smoke`.
- LibreCAD (`~/Documents/plate.dxf`, four holes added, rewritten from DXF R12
  to 2007: 2,944 lines added, 86 removed): the draft lists the 11 lines found
  at both ends whose count changed and suggests counts of `SECTION`, `ENDSEC`
  and `CIRCLE`. A task with `CIRCLE` equals 9 was exported: 5 on the seed, 9
  at the end.
- Typora: the capture predates the vendor package fields and is refused as
  malformed (`apt_repositories.0.architectures`), as expected.
- The generated verifiers, run under agentenv-protocol 0.9.1431 against homes
  holding the seed and the captured end state, read through the generated
  class's own `_views`: Mousepad and LibreCAD each fail on the seed and pass
  at the end.

## In an agentenv computer

The CLI-exported Mousepad bundle, with two model-free tasks added on a
scratch copy, ran with `agent-env run --no-emulate` on local Docker (arm64):
the app image built and reached ready, and the generated verifier reached the
app through the computer's card at `/svc/mousepad` under the run's grant. On
the seed it scored 0 (`milk-listed` false, `bread-kept` true); after
`load_artifact` put the captured end-state `todo.txt` in `Documents` it
scored 1. Both sandboxes were torn down.

A fresh capture of the same edit, exported with a task of three checks
(`milk` and `bread` present, `one-milk` counting exactly one "buy milk"
line), was then run without an agent and driven through the computer's own
input tools:

- `agent-env run --dry-run` of the bundle planned the eval's one task,
  `add-milk`, with Claude Code as the solver.
- A probe task (`deploy_env`, then the exported verifier) ran with `--keep`:
  the `env_outcome_verifier` step scored 0, recording `milk` and `one-milk`
  false and `bread` true.
- On that computer, `computer_click`, `computer_key` and `computer_type`
  added "buy milk" in Mousepad and saved it with Control+S. The exported
  `verify.py`, called under the computer's control-token grant as the step
  calls it, then passed all three checks. A second "buy milk" line failed
  only `one-milk` (2 lines), and after `data/reset` the checks read as on the
  seed again.
- The sandbox was torn down with no container left.

## Limits of this verification

- No computer-use agent ran, so no solve rate was measured: the runner has no
  model endpoint here.
- SQLite and dconf readers were not exercised on the host captures, which
  hold text files; SQLite checks are covered by synthetic views.
- The XML namespace refusal and the CDATA difference the export guide lists
  are covered by code review only.
