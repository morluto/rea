# Tasks

- [x] Record the portable-runtime outcome, requirements, acceptance, limits, and
      implementation plan.
- [x] Select locked win32/x64 production dependencies with npm platform
      semantics and the required-native-package guard.
- [x] Assemble the application, dependencies, Node runtime, native module,
      launchers, guide, and completion manifest without overwriting an existing
      output directory.
- [x] Add bounded manifest and inventory traversal, size checks, and streamed
      SHA-256 verification.
- [x] Add PowerShell and Command Prompt launchers with literal-path handling and
      live stdio MCP forwarding.
- [x] Add the portable verifier for launchers, offline setup/doctor, repeated
      setup, CLI/MCP analysis parity, source preservation, and uninstall.
- [x] Add focused dependency, inventory, command, fixture, and CI-routing
      regressions.
- [x] Add the Windows CI preparation and PowerShell 5.1/7 verification steps and
      route guidance changes through the package lane.
- [x] Resolve review findings: plain child scratch root, pinned Node example,
      digest verification owner, network-guard control, and MCP stderr draining.
- [x] Refresh stale expectations that blocked the branch's Windows and Linux
      lanes: Kimi profile fixture, environment-card bytes, capture progress
      ordering, and the persisted snapshot target shape.
- [ ] Confirm the final-head CI shards, Windows verifiers, and required gate.
