# Verification

Local verification on Linux x64, Node 22.

- Focused parser, service, filesystem boundary and tool-effect tests (see PR
  description for exact commands and counts).
- `tsc --noEmit` over the project.

## Not yet verified

- Dumps produced by real Windows producers; fixtures are hand-authored from
  the documented structure layouts.
- Compiled CLI and stdio MCP parity beyond the shared service/contract path.
- Token usage and peak memory are unmeasured.
