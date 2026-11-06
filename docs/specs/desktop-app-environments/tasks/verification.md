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
- `npx vitest run src/domain/desktop src/application/desktop src/desktop`
  with the two Python boundary tests: 261 passed and 14 skipped on macOS; 274
  passed and 1 skipped in the container.
- CLI boundary tests `cliInputSchemaRequired`, `cliToolCoverage` and
  `cliStartupImports`, `setupSkill`, and the Python boundary tests
  `desktopExportPython` and `desktopTaskPython` (macOS and container): passed.
- New tests: 68 checks covering every kind against views of every format
  (text, a truncated text view, JSON with numbers, booleans, arrays and
  escaped pointers, a key file, a truncated XML view, SQLite with a truncated
  and an unreadable table and a database whose tables were cut, binary, a
  view error, an absent file), asserted for the TypeScript evaluator and for
  the rendered `verify.py` under `python3 -I` with a stub protocol client,
  which agree on every result and description and call the app at
  `/svc/notes`, including `contains` given a pattern-like string and whole
  objects and arrays on truncated XML and SQLite views; 19 task refusals,
  among them a `regex` field; suggestions for text, a format rewrite, key
  files, SQLite rows and created and deleted files, and drafts that keep a
  database whose rows changed under an unchanged hash and a file whose
  truncated views match while it changed, and that leave out a database with
  one version; the export with a task and nine
  refusals, among them a byte-order mark reported with the reader's fix, none
  writing a bundle; and a draft the export accepts.

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
- Typora, captured again (`~/Documents/trip.md`, a to-do "Buy trail snacks"
  and a table row "Sun | Lake swim" added): among about 25 changed files
  under `.config/Typora`, the draft suggested only the document's two new
  lines. A task checking both, with "- [ ] Book the cabin" kept, was exported
  (`snacks` and `sunday` failing on the seed); tasks checking only the cabin
  or a kayak to-do were refused. The capture made before the vendor package
  fields is refused as malformed (`apt_repositories.0.architectures`), as
  expected.
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

The Typora bundle ran the same way, its build installing Typora from the
vendor repository: the probe's verifier step scored 0 (`snacks` and `sunday`
false, `cabin-kept` true); the same input sequence as the capture (Control+Home,
two ArrowDown, End, Enter, the to-do, Control+End, Control+Enter, the row,
Control+S) made all three checks pass; and after `data/reset` they read as on
the seed. That sandbox was torn down too.

## Solve rate

The three bundles, exported again from this branch's final code, ran with the
documented recipe: `agent-env run <bundle> --task NAME --agent claude-code
--model anthropic/claude-sonnet-5-5 --no-emulate`, three times each, on local
Docker through a LiteLLM endpoint.

| Task                 | Runs passed | Cost per run (USD) |
| -------------------- | ----------- | ------------------ |
| Mousepad `add-milk`  | 3 of 3      | 0.91, 0.39, 0.39   |
| Typora `plan-sunday` | 3 of 3      | 0.77, 0.31, 0.43   |
| LibreCAD `add-holes` | 3 of 3      | 0.81, 0.32, 0.34   |

Costs are Claude Code's own totals, $4.67 for the nine runs. Every run worked
through the computer's input tools only (screenshots, clicks, keys, typing;
in LibreCAD, circle commands typed into its command line), loaded the app's
skill first, and passed every check of its task. None failed to finish.

Each task is a single change the user made in one sitting, so Claude Sonnet
5.5 solves all three every time: they show the exported environments work
end to end, not how hard a task can be.

## Limits of this verification

- SQLite and dconf readers were not exercised on the host captures, which
  hold text files; SQLite checks are covered by synthetic views.
- Namespaced XML and CDATA, which the export once refused or read
  differently, are covered by the document views' parity tests on real
  Inkscape and LibreOffice saves, not by a host capture.
