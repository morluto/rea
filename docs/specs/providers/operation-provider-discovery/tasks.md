# Tasks

This specification was written after the first implementation, in response to
automated review on the pull request. The checked items record work completed
on that branch.

- [x] Record base behaviour: the operation detail and CLI flag are rejected, and
      summary/complete sizes are measured.
- [x] Add the contract, requirements accessor and candidate projection with
      application tests.
- [x] Add MCP output shapes, hidden-family refusal and MCP tests; add the CLI
      flag and test.
- [x] Rebase on current `main`; adapt the MCP test to per-test temporary
      directories.
- [x] Cover `get_navigation_context` through its availability modes.
- [x] Refuse invalid operation input before MCP family availability probes.
- [x] Report target-free candidates in resource-only sessions.
- [x] Mark readiness-gated declarations in IDA, Kuna and Ghidra, leaving
      Ghidra's Windows edit ban unmarked.
- [x] Real-provider workflow with Kuna 1.990 on Linux.
- [ ] Real-provider workflow with Ghidra or Hopper.
- [ ] A switch to a second available provider.
- [ ] A dedicated test for requirement groups satisfied by any one operation.
