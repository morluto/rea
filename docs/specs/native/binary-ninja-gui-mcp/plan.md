# Binary Ninja GUI MCP provider plan

This record describes the implementation under review and how to verify it.
See the [specification](spec.md) for the scope and acceptance criteria.

- Keep registration parsing and GUI protocol handling in the Binary Ninja
  adapter. Use the shared registration reader, UTF-8 response validator and
  regex worker where applicable.
- Register the provider with the existing analysis selection, doctor and
  capability discovery paths. Route CLI and MCP calls through the same session.
- Bind the selected executable to an open view by digest. Keep view selection,
  target checks and restoration in the session that owns the connection.
- Normalize read-only replies to REA's existing contracts. Retain observations
  alongside the result and surface unsupported facets as limitations.
- Verify with the adapter fixtures and the
  [live GUI workflow](../../../providers/binary-ninja.md#verification).
  Record the platform and version gaps in [tasks](tasks.md).
