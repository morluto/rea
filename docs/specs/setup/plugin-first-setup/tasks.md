# Tasks

- [x] Prefer Codex and Claude Code plugins when `preferPluginSetup` holds; keep
      incompatible registration settings on the direct path (FR: routing).
- [x] Keep Cursor on direct registration by default; install a local plugin only
      with `--cursor-plugin` or when a matching local plugin is already present
      (FR: Cursor opt-in).
- [x] Require plan preview and approval before marketplace commands, downloads
      and publication; preserve existing direct integrations (FR: approval,
      preservation).
- [x] Stage and validate Cursor npm acquisition before publishing; preserve
      foreign or incomplete destinations with remediation (FR: Cursor install).
- [x] Carry cancellation, owned cleanup retry and plugin readiness advice through
      setup diagnostics (FR: cancellation, readiness).
- [x] Cover routing, approval, preservation and acceptance cases with focused
      and public setup tests (FR: acceptance).
- [x] Document operator behavior under Agent plugins and marketplaces.
- [x] Include shared `scripts/lib` runtime modules imported by
      `CursorLocalPlugin` in `compile.inputs` (FR: compile cache).
