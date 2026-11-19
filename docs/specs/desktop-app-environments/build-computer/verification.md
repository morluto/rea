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
  runner failure with its output; removal by name and label; an unconfirmed teardown
  retried after Docker recovers; cancellation of a start stopping the helper;
  a long build's failure reported from the end of its output; a first
  screenshot too large for the response that keeps `computer_id` for act and
  close; the first screenshot's options. No result carries the control token.
- `tests/boundary/providers/buildComputerRecording.test.ts`: recording start,
  end and one fetch per segment under REA's request id, the action log, a
  long session's log kept within its allowance with every action counted and
  the driver still getting each argument whole, a segment that differs from
  its manifest, a recording over the allowance refused before any read, and an
  answer outgrowing its segment's size.
- `src/application/desktop/DesktopBuildActionLog.test.ts`: the log names only
  the arguments it cut, cuts text without splitting a character, and records
  the outcome of an action dropped while it was pending.
- `tests/boundary/providers/buildComputerLifecycle.test.ts`: shutdown cancels
  and joins a start in progress and refuses later starts; a failed start whose
  teardown is unconfirmed stays held under the id its error names, keeps its
  primary failure, and is released by a retried close and by shutdown.
- `src/process/ProviderProcessOutput.test.ts`: the supervisor's tail retention
  keeps each stream's latest bytes, reports checkpoints over dropped bytes as
  incomplete, and drops a UTF-8 character the cut would split.
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

## Real computer

Run on 2026-11-05 on Ubuntu 24.04 amd64 with Docker, agentenv-framework
0.9.1431 and Node v24.22.1. REA's archive was packed from this tree with
`npm pack`, then `npm ci --omit=dev --omit=optional` in its `rea-prod` folder,
18.5 MB as `.tar.xz`.

- `tests/boundary/providers/buildComputerReal.test.ts` passed in 25 s with the
  image built; the first run, which builds it, took 109 s.
- Through `rea mcp` over stdio: `start_build_computer` from the Mousepad
  request came up in 31 s with its first screenshot as a PNG. Mousepad opened
  from Applications, Other, `mousepad`; a typed line was saved with `ctrl+s`
  through the Save As dialog; actions took 6 to 60 ms beside the driver's own
  typing and waits. `rea --version` answered 6.8.0 in the computer for its user
  and root. `close_build_computer` took 0.5 s with `teardown: "agentenv"` and
  left no container. The exported Inkscape bundle started cold in 59 s and
  closed the same way; a start cancelled at 60 s left nothing up.
- With the helper killed, close removed the computer's container by its name,
  `agent-<sandbox id>`: agentenv labels only its VM and closed-network
  containers.
- No result or log held the control token.
