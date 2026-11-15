# One client table for setup, maintenance and `rea mcp add`

## Status

Accepted, 2026-11.

## Context

`rea mcp add` kept its own table of clients, locations and file dialects,
separate from the table that setup, doctor, update and uninstall read. A client
registered through `mcp add` was invisible to the lifecycle commands, and each
table interpreted the same configuration files independently. Some clients
(Gemini, Junie, Goose, Kilo) decide which registration they load from more than
one file, from environment variables, or from layers REA must not change, so
two interpretations drifted in where to write and what the effective entry is.

## Decision

[`SupportedClients.ts`](https://github.com/morluto/rea/blob/main/src/application/SupportedClients.ts)
is the single client table. Each row is the owner of one client's user-scope
registration, and every command reads that row:

- **Dialect and reader facts are separate fields.** `format` names the file
  dialect REA parses and writes. Read-scope facts that decide what the client
  loads without being write targets (`geminiSettings`, `junieSettings`,
  `zcodeFallbackPath`, the ordered `configPaths`) are separate fields, so a
  consumer never infers loading rules from the dialect.
- **`mcpAdd` exposes a row to `rea mcp add`.** It adds aliases and project paths
  only; the user-scope registration uses the row's location, format, profile and
  read-scope facts, so `mcp add` does not keep a second definition of a table
  client.
- **Locations that depend on observed layers use one asynchronous hook.**
  A row's `layeredLocation` returns the write target and every layer in load
  order once present files are observed. `resolveSupportedClients` applies it
  for setup, doctor, update and uninstall, and `mcp add` resolves Kilo's user
  scope through the same location owner; the synchronous row keeps the default
  target and every candidate layer.
- **Lower layers can be read-only.** A row with `readOnlyLowerLayers` has
  layers before `configPath` that belong to the system or an administrator. REA
  reads them to compute the effective registration and writes only
  `configPath`. An inline layer that a client reads from its environment
  (Kilo's `KILO_CONFIG_CONTENT`) is `inlineConfiguration`: the
  highest-precedence layer, read for the effective registration and never
  written.
- **Uninstall refuses rather than misreport.** When a read-only layer would keep
  REA's enabled registration in effect, or removing the user entry would expose
  one, uninstall makes no change and names the layer's owner as the recovery.
  When only an inline layer sets REA's enabled entry, uninstall reports that
  client as failed and names the variable to edit, as doctor does.
  An unreadable layer leaves the outcome unknown and also stops uninstall.

## Consequences

- Doctor, update and uninstall see every registration `mcp add` writes, and a
  client added to the table is available to all commands at once.
- A client-specific loading rule has one parser, owned by the row's field;
  consumers use its parsed facts instead of rereading raw files.
- Commands that need the layered location must call `resolveSupportedClients`;
  the synchronous `supportedClients` view is not sufficient for those rows.
- Uninstall can report a registration it cannot remove; that client then needs
  its layer owner's action before uninstall completes.
