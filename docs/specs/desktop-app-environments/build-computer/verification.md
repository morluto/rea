# Verification

Run on 2026-11-05 on macOS 26.5 with Node v24.22.1 and Python 3.11. Docker and
agentenv were not used by the gates or the boundary tests.

## Tests

- `src/domain/desktop/appBuild.test.ts`: the bundle for an archive package, an
  apt repository with its key and a `.deb` with a downloaded REA; the Node.js
  pin matches REA's; refused desktop entries, credentialed or non-http URLs and
  relative bundle paths.
- `src/domain/desktop/computerActions.test.ts`: key translation, argument
  pass-through and refusal of an argument the action does not take.
- `tests/boundary/mcp/buildComputerMcp.test.ts`, through the public MCP tools
  with REA's real helper, a fake `agent_env` package on `PYTHONPATH` and a fake
  driver serving readiness, `computer_*` tools over streamable HTTP,
  recording and `data/get`: start with readiness polling, the image pass-through,
  argument pass-through and key translation, a driver refusal, a refused
  argument, close and a later unknown id; a request bundle with REA's payload,
  compiled by the fake runner; the missing payload and runner settings; a
  runner failure with its output; removal by label; an unconfirmed teardown
  retried after Docker recovers; cancellation of a start stopping the helper.
  No result carries the control token.
- `tests/boundary/providers/buildComputerRecording.test.ts`: recording start,
  end and segment fetch under REA's request id, the action log, and a segment
  that differs from its manifest.
- `tests/boundary/providers/buildComputerReal.test.ts`: opt-in with
  `REA_BUILD_COMPUTER_REAL=1`, `REA_AGENT_ENV_COMMAND`, `REA_DOCKER_COMMAND` and
  `REA_BUILD_COMPUTER_REA_ARCHIVE`; skipped here.

## Checks against agentenv

- `python -m agentenv_protocol.computer._declare` from agentenv-framework
  0.9.1431 declared both a Mousepad archive bundle and a `.deb` bundle with a
  downloaded REA: packages, downloads per architecture, both run scripts and
  the demand launch.
- `install-rea.sh` ran as root with the network off in a local Ubuntu 24.04
  container against a Node.js-shaped and an REA-shaped archive: it unpacked
  both into `/opt/rea`, put `node` and `rea` on `PATH` and removed the
  archives.

## Not verified

- A real computer: the opt-in test is for an amd64 host with agentenv and
  Docker.
