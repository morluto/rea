# Windows quick tools launcher

## Outcome and scope

Give a Windows analyst a double-clickable, Thai-first entry point to the
common REA flows (doctor, MCP doctor, one-file native analysis, the Thai
quick reference) without a terminal, and ship it inside the npm package so
an installed REA can launch it.

The launcher stays a thin menu over documented CLI commands: it owns no
analysis logic, runs no target code itself, and every action maps to one
public `rea` command documented in `docs\getting-started\windows-quicktools.md`.

## Launcher contract

- UTF-8 output (`chcp 65001`), bilingual labels, no external dependencies
  beyond `node.exe` and the packaged `scripts/rea.mjs` entry.
- Discovery order: `node.exe` from PATH, then the entry at
  `%APPDATA%\npm\node_modules\rea-agents\scripts\rea.mjs`, then the
  repository checkout two levels above `tools/windows/`. A `.cmd` shim
  fallback is intentionally absent: CALL would re-parse reconstructed
  arguments.
- Install locations containing `!` are refused before delayed expansion
  starts; delayed expansion consumes `!` and would corrupt such paths.
- Every analyst-provided value (menu input, pasted paths, function names,
  search terms) is only ever referenced through delayed expansion. Fixed
  actions (doctor, mcp doctor, PE resources) dispatch one `!REA_ARGS!` line;
  the three selector actions (function decompile, strings search,
  procedure search) dispatch through a quoted FOR-carrier into a
  single-shot `:RUN_ONE` subroutine. Values never travel through
  parse-time `%*` or CALL re-expansion.
- Leading-dash function symbols and search terms route through the
  documented `--procedure=` / `--pattern=` selectors instead of positionals.
- Selector transport limits: a quoted FOR-carrier token cannot carry a
  literal quote, ! is consumed by delayed expansion on any batch line,
  and `*` / `?` make the FOR-set enumerate the current directory. The
  launcher refuses all three with an explicit message instead of
  running an altered selector; the command line carries them faithfully.
- A closed stdin stops the launcher; menu variables are cleared before
  every read, so EOF cannot re-run the previous action.
- `setlocal` wraps the whole script: no environment assignment leaks into
  the calling shell.

## Verification

`tests/test_windows_quicktools.py` executes the real launcher through
cmd.exe with a recording `rea.mjs` stub: menu wiring, closed-stdin
handling, quoted drop-path delivery, injection resistance and the
`--pattern=` routing are asserted against the actual dispatched argv,
not the file's text. Structure guards run on every OS; behavior tests
require cmd.exe and run on the Windows host lane registered as
`scripts/run-python-tests.py --windows-tools`.
