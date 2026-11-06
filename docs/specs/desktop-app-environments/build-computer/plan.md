# Plan

1. Domain: the build request schema and the bundle renderer beside the
   export's renderers, reusing their env.toml, apt source, install script,
   smoke task and naming helpers; the action schema, per-action argument
   admission and key translation.
2. Helper: `bridge/agentenv/computer.py`, shipped in the package, with its
   exit statuses (0 torn down, 1 left up, 2 nothing came up).
3. Adapter: `src/desktop/AgentEnvComputer.ts` finds the runner's Python,
   spawns and supervises the helper, reads the handshake, waits for readiness,
   holds the driver MCP session and the token, serves the recording hooks and
   releases the computer, removing its containers by name and label when needed.
4. Application: `DesktopBuildComputers` renders request bundles into a private
   folder, starts and holds computers, forwards actions with their log, and
   closes them, keeping unconfirmed ones for retry.
5. MCP: contracts, effects, the `application` family, the capability service,
   registration, image pass-through in `ToolResultDelivery`, and the MCP-only
   list for CLI parity.
6. Docs and tests: the guide; renderer and key tests; boundary tests with a
   fake driver and a fake `agent_env` behind the real helper; an opt-in real
   test with agentenv and Docker.
