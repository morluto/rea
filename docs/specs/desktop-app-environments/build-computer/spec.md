# Build computer

## Outcome

An agent that builds a desktop app environment, such as Claude Code, drives a
real agentenv computer through REA's own MCP tools: REA keeps the computer up,
forwards each computer-use action to its driver and returns the driver's answer,
screenshots included, then tears the computer down. The computer starts from a
request (the app's install source and desktop entry), with REA installed inside
it for building, or from an existing bundle folder.

## Requirements

- MCP-only session tools in the `application` family: `start_build_computer`,
  `act_on_build_computer` and `close_build_computer`, held by one owner per
  server and closed with it.
- Lifecycle: one helper process per computer, `bridge/agentenv/computer.py`,
  spawned with REA's owned-process supervision and run with the agentenv
  runner's Python, found from the absolute `REA_AGENT_ENV_COMMAND`. It calls
  `run_bundle(<bundle>, tasks=["smoke"], keep=True, emulate=False,
  sandbox="local")`, prints one JSON line (base URL, MCP URL, control token,
  sandbox id) on a private copy of stdout, sends everything else to stderr,
  and tears down on stdin EOF, SIGTERM or SIGINT. REA waits for
  `GET /agentenv/ext/computer-ready/status` with the token, then holds one MCP
  session to the driver's `/mcp`.
- Teardown: closing stdin, then SIGTERM, then the process group. When the helper
  does not confirm the teardown, REA removes the containers of the exact
  sandbox id it reported, the one named `agent-<sandbox id>` and any labelled
  `agentenv.sandbox=<sandbox id>`, through the absolute `REA_DOCKER_COMMAND`. An
  unconfirmed teardown keeps the computer listed for a retried close.
  Cancelling a start stops the helper, whose deploy tears down what it began;
  a helper that reported its failure finishes its own teardown first. The owner
  holds each start from its helper's spawn: a failed start whose teardown is
  unconfirmed stays held under the `computer_id` its error names, and shutdown
  cancels and joins starts in progress before closing every computer.
- Diagnostics: the helper's stderr is kept as its last 16 KiB, through the
  shared supervisor's tail retention, so a failed build reports its error
  rather than its first package downloads.
- The control token never appears in a result, an error or a log; the helper's
  stderr is redacted of it.
- Build bundle from a request: the app from the Ubuntu archive, an apt
  repository with its key file, or a `.deb` URL with its SHA-256, dependencies
  and architecture, rendered with the export's install shapes and Python
  helpers; `Launch(at="demand")` through `gtk-launch`; no seed and no data
  hooks; REA in a build-only layer, with Node.js 24.22.1 downloaded per
  architecture and checked, and REA's payload a parameter: a local archive
  shipped in the environment folder (`REA_BUILD_COMPUTER_REA_ARCHIVE`) or,
  later, a released download.
- Actions: one tool with an `action` (screenshot, click, drag, scroll, type,
  key, wait) and the driver's own arguments, passed through, frame or `norm`
  coordinates included. Common key spellings become W3C names. An argument the
  action does not take is refused before sending. Results carry the driver's
  content blocks unchanged after REA's JSON, which `ToolResultDelivery` measures
  against the response budget as a whole; a response over it is refused with
  REA's own result, `computer_id` included, kept in the error. The first
  screenshot takes `region`, `format` and `quality`. Each action is logged per
  computer within a fixed allowance: the latest 256 actions in 256 KiB of JSON,
  oldest dropped first, each string argument cut to 1 KiB and each list to 64
  items with the cut arguments named, beside a count of every action and the
  index of the last applied action of each kind.
- Recording hooks, internal: start and end `computer-recording/v1` under REA's
  request id, and fetch the segments through the driver's `data/get` one per
  request, each answer read within its segment's base64 size and the segment
  checked against the manifest's size and SHA-256, before teardown. A
  recording over the caller's allowance, a quarter of the V8 heap by default,
  is refused before any read.

## Non-goals

- Capture checkpoints, the apt lists folder, the capture's launch environment
  and the host scrub, which a sibling change owns.
- The witness and its record, which read the action log and recordings.
- Remote sandbox providers, emulated architectures, VNC, and reaping orphans
  left by an earlier REA process.
