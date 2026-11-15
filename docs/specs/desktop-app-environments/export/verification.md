# Verification

Run on 2026-11-04 on top of the state view branch: gates and source tests on
macOS 26.5 with Node v22.23.1; the end-to-end run in an Ubuntu 24.04.5 arm64
container with Node v24.22.1, Mousepad 0.6.1 and agentenv-framework 0.9.1431
installed from PyPI into a virtual environment.

## Gates

- `npm run typecheck`, `lint`, `lint:typed`, `format:check`, `knip`, `jscpd`,
  `docs:check`, `mcp-catalog:check`, `verify:test-discovery`,
  `verify:architecture-guards` and `scan:todos`: passed, with no lint
  diagnostics in the new source files.
- New tests: names, owned paths, the launch command, env.toml and the class
  with and without data hooks; the service writing a bundle from a synthetic
  capture, and refusing an application with no package archive source.

## Mousepad end to end

`~/Documents/todo.txt` held `buy bread`. Mousepad was captured opening it
(`--argument /home/ada/Documents/todo.txt`) while `xdotool` added `buy milk`
and saved; the capture was exported, then checked with agentenv:

- The export wrote `envs/mousepad/{env.toml, mousepad_app.py, SKILL.md,
  seed/Documents/todo.txt}`, `tasks/smoke.json` and `README.md`. Owned paths:
  `.config/Mousepad` and `Documents`; seed: `Documents/todo.txt`.
- `python -m agentenv_protocol.computer._declare . mousepad_app.py Mousepad`
  exited 0 and declared apt `mousepad`, the launch with window class
  `Mousepad` and a window ready check, both paths, the skill file and
  `data/add`, `data/get` and `data/reset`.
- `agent-env run <bundle> --dry-run` exited 0, planning `envs/mousepad` and
  `tasks/smoke.json` on the `ubuntu-24.04` computer with the `reference`
  driver.
- Importing the class and calling its helpers: the typed view of
  `Documents/todo.txt` on the capture host was `["buy bread", "buy milk"]`;
  seeding a fresh home wrote `Documents/todo.txt` with `buy bread`; the launch
  command is `sh -c "exec 'mousepad' \"$HOME\"/'Documents/todo.txt'"`.
- The generated dconf loader, run on its own: on a fresh home it compiled the
  captured keys into `~/.config/dconf/user`; over an existing database the
  captured keys won and other groups stayed; with no `dconf` binary it printed
  one warning and returned.

## Limits of this verification

- The bundle was not deployed: no image was built and the app did not boot in
  a computer. That is the next step, with its recording.
- The output tree refused a bind-mounted macOS folder as the bundle directory
  (its directory identity is not stable there), so the run wrote the bundle
  inside the container and copied it out.
