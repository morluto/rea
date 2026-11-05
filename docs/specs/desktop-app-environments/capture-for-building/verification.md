# Verification

Run on 2026-11-05 on top of the namespaced XML and capture fixes branches:
gates and source tests on macOS 26.5 with Node v22.23.1 and Python 3.11.14;
Linux tests and the end-to-end capture in an Ubuntu 24.04.5 arm64 container
with Node v24.22.1, Python 3.12.3, apt 2.8.3, Xvfb, xfwm4 and Mousepad
0.6.1-1build2, run as the ordinary user `ada` on a container whose host name
is its id.

## Gates

- `npm run typecheck`, `format:check`, `build:cached`, `knip`, `jscpd`,
  `docs:check`, `docs:build`, `verify:test-discovery` and
  `verify:architecture-guards`: passed. `lint` and `lint:typed` fail only on
  main's own `tests/acceptance/webSourceLocationCli.test.ts`, with no
  diagnostics in the touched files. Of the two clones jscpd lists in touched
  files, one is a new test's nine-line import block and the other a pair of
  cancellation tests already in `DesktopApplicationCapture.test.ts`.
- `npx vitest run src/domain/desktop src/application/desktop src/desktop`
  with `tests/boundary/providers/desktop*.test.ts` and the desktop CLI
  boundary tests `cliStartupImports`, `desktopCaptureCli`,
  `desktopApplicationCli`, `cliInputSchemaRequired` and `cliToolCoverage`:
  468 passed and 20 skipped on macOS (the Linux-only cases); 485 passed and 3
  skipped in the container.

## Tests

Each new test fails on the code before this change, run from that code with
only the new tests and fixtures added: on macOS for the source and CLI tests,
in the container for the three Linux-only ones.

- The scenario: a capture where the app saves a new note before `seed`, edits
  it before `end`, and writes its settings as it exits. Exported with
  `--seed-checkpoint seed --end-checkpoint end`, the bundle seeds the note as
  saved at `seed` and the settings as they were then, and a task whose check
  of the edit fails at `seed` and passes at `end` is kept. A check that holds
  only at `exit` is refused with the end at `end` and kept with the end left
  to default. Without the options the seed is the baseline, without the note.
  The draft between the two lists only the note, with `eggs` added. An
  unknown name and an end before the seed are refused naming the option,
  under the export's and the draft's own operations, and write no bundle.
  The same options through the public CLI, with a refusal's structured
  issue.
- The scrub's rules: Geany's `pref_template_mail=ada@e81232be457d` becomes
  `user@localhost` while `pref_template_developer=ada` stays; the host name
  alone becomes `localhost` but not inside `xe81232be457d`, before `-2` or in
  `e81232be457d.local`, and a host named `ubuntu` leaves
  `ports.ubuntu.com/ubuntu-ports` alone; the home where a path segment ends,
  not `/home/adam` or `/home/ada.bak`; only the home for a capture without
  the host's name and user; a UTF-8 byte-order mark kept; UTF-16 seeds in
  both byte orders; leftovers found in a binary database and in
  `e81232be457d.local`; nothing to replace in a capture whose home is
  `/home/user`.
- Through the export: a capture whose settings file, SQLite database and
  dconf keys name the host and user. No bundle file but the database holds
  the host name, `ada@` or `/home/ada`; the settings seed is rewritten, the
  class holds `SEED_HOME = "/home/user"` and the scrubbed dconf keys, and the
  result and README list the rewritten settings and the database. Checks
  naming `ada@e81232be457d` or the host name are refused; a capture written
  before the host was recorded still parses and has its home replaced.
- apt folders: lists in the folder a stubbed `apt-config` names, with a
  quoted `'` in its name, are found, and the default folder is used when
  `apt-config` fails or is missing (adapter test); on Linux, real
  `apt-config` under an `APT_CONFIG` file resolves `Dir::State::Lists`
  relative to `Dir::State`, and a missing `apt-config` gives the defaults.
- Linux: a launched shell's environment has no `AGENTENV_*` variable while
  it keeps the others and the run token; a capture of the fake application
  records the host's name and user as Node reads them.

## Mousepad end to end

As `ada`, with no apt lists in `/var/lib/apt/lists`, an `apt-get update`
under an `APT_CONFIG` naming `/tmp/apt-user/lists` and `/tmp/apt-user/cache`
wrote 15 Packages lists there. With that `APT_CONFIG` and
`AGENTENV_CONTROL_TOKEN` set, `capture-desktop-application --desktop-entry
org.xfce.mousepad` ran while `xdotool` typed `milk` and
`from ada@<host name>`, saved the file as `~/Documents/list.txt`, sent
`checkpoint seed`, typed `eggs`, saved, sent `checkpoint end` and then
`stop`.

- Mousepad's environment held the run token and no `AGENTENV_*` variable.
- The package is `mousepad` 0.6.1-1build2 from
  `http://ports.ubuntu.com/ubuntu-ports noble/universe arm64 Packages`, origin
  `Ubuntu`, with `package_lists_present` true and no apt limitation.
- `host` records `/home/ada`, the container's host name and `ada`; the
  checkpoints are `baseline`, `seed`, `end`, `stop` and `exit`.
- The draft between `seed` and `end` lists `Documents/list.txt` with `eggs`
  added and suggests `lines_present` of `eggs`.
- The export with `--seed-checkpoint seed --end-checkpoint end` and that check
  kept the task (`failing_on_seed: ["eggs"]`), seeded `list.txt` as
  `milk\nfrom user@localhost\n` and listed it in `scrubbed_files`;
  `unscrubbed_files` is empty and no bundle file holds the host name, `ada@`
  or `/home/ada`. The dconf keys' recent file is
  `file:///home/user/Documents/list.txt`. A task checking the line
  `from ada@<host name>` was refused, and the export without options seeded
  nothing, since the note did not exist at the baseline.
- The exported module's own `_seed_home` wrote `list.txt` unchanged into
  another home and respelled the dconf keys' path to it.
  `python -m agentenv_protocol.computer._declare` of agentenv-framework
  0.9.1431 declared the class, and `agent-env run --task smoke --dry-run`
  planned the deploy.

## Review fixes

Run on 2026-11-05 on the same toolchains, after the first review. Each new
test failed on the reviewed head, with only the new tests added, and passes
now.

- A task's seed checks read the seed as the bundle ships it. A mail setting
  changed from `ada@e81232be457d` to `user@localhost` already reads
  `user@localhost` in the scrubbed seed, so its check is no longer counted as
  failing there: `failing_on_seed` went from `mail` and `note` to `note`.
- JSON is scrubbed by its strings' decoded values, so a host named `true`
  leaves `{"enabled": true}` valid and a `\u0065` escape no longer hides the
  host; an untouched string keeps its escapes. XML is scrubbed in its decoded
  character data and attribute values, comments and CDATA, so a host named
  `item` leaves `<item>` alone and `&#x65;` references hide nothing; the
  output is still read as XML.
- One search for what is left covers every shipped file, in its path and its
  content: a clean seed named `e81232be457d-notes.txt`, the class module
  whose dconf keys hold `ada@e81232be457d.local` and the README that lists
  them are listed in `unscrubbed_files`, which now names bundle paths and
  equals an independent search of the bundle. A task check holding
  `e81232be457d.local` is refused by the same rule. The replacements are set
  aside, so a host named `host` is not found in `localhost`.
- A host named `localhost` keeps that name, but `ada@localhost` becomes
  `user@localhost`, and a binary file holding it is reported.
- A second review found member names rewritten too: on a host named
  `ubuntu`, `{"ubuntu": 1, "localhost": 2}` got two `localhost` keys. Names
  are now kept, an escaped one before a colon on the next line included, and
  a seed whose JSON key holds the host ships as captured and is listed in
  `unscrubbed_files`.
- The same review found that the regular expression that found JSON strings
  threw `RangeError: Maximum call stack size exceeded` on one string of
  16,000,000 characters, which a 64 MiB capture can retain, so such a seed
  stopped the export. The scrub now walks the document one string at a
  time, and that seed is scrubbed in about 20 ms. The XML expressions, run on
  a comment, CDATA section, processing instruction, attribute value and text
  of the same length, finished within 6 ms each.

The gates passed as before, `lint` and `lint:typed` again failing only on
main's `webSourceLocationCli.test.ts` with no diagnostics in this change's
files; the desktop tests ran 483 passed and 20 skipped on macOS, and 500
passed and 3 skipped in the container, where the Mousepad run above gave the
same result, its rewritten seed now listed by bundle path.

A third review found four more. Each new test failed on the reviewed head and
passes now; `src/domain/desktop`, `src/application/desktop` and
`tests/boundary/providers/desktop` ran 404 passed and 11 skipped on macOS.

- dconf keys were scrubbed as one text, so on a host named `true` the setting
  `wrap=true` became `wrap=localhost`, which `dconf compile` refuses, and
  keys and group names could be renamed. Only decoded GVariant strings change
  now; a value that does not parse ships as captured and the class module is
  listed in `unscrubbed_files`.
- A task's check was searched as serialized JSON, so on a host named `file`
  or `kind` every check was refused for its field names. Only its values are
  searched now, not its field names, kind or id.
- A value check was refused when its file was text at any recorded version;
  an empty `.json` before `seed` or after `end` refused a task whose file is
  JSON at both. Only the seed, as shipped, and the end are read now.
- UTF-16 JSON and XML were scrubbed as plain text, so on a host named
  `ubuntu` `{"ubuntu": 1, "localhost": 2}` got two `localhost` keys. They are
  scrubbed by the format their text would have in UTF-8, in their own byte
  order.

## Limits of this verification

- The bundle was not run in an agentenv computer, and REA was not run inside
  one; the build computer is a later step.
- Geany's leak is covered by a fixture with its line, not by capturing
  Geany. No real application was captured with a UTF-16 seed or a binary
  file holding the host name.
- The apt-config fallback for a missing command and a failing one is covered
  by the adapter test, and the real command only on Ubuntu 24.04.
