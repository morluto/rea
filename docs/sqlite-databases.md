# SQLite database snapshots

`inspect_sqlite_database` / `inspect-sqlite-database` inspects one explicitly
selected local SQLite database snapshot without an active native analysis
target. Use it to understand application storage, configuration or retained
database evidence. No separate SQLite installation is required.

This operation requires Node.js 24.x >=24.15 or 26+ with the native
`DatabaseSync.limits` API. The worker verifies that capability before querying
the copied database. Other REA features retain their published Node.js 22.x,
24.x or 26+ requirements.

```sh
rea inspect-sqlite-database ./application.sqlite --json
rea inspect-sqlite-database ./application.sqlite --table settings --row-limit 20 --json
```

```json
{
  "name": "inspect_sqlite_database",
  "arguments": {
    "path": "/artifacts/application.sqlite",
    "table": "settings",
    "row_limit": 20
  }
}
```

MCP paths must be absolute filesystem paths on the current host. CLI paths
resolve against the operator's working directory. Select a quiescent snapshot:
stop the writer or obtain a consistent database/WAL pair using the application's
backup workflow before inspection. A file copy of a live pair does not establish
an atomic SQLite snapshot, even if no change is detected during inspection.

## Returned evidence

The complete schema inventory includes tables and their columns, indexes, views
and triggers. SQL declarations retain the original schema text. Virtual and
shadow tables are identified as such; their supported metadata coverage is
reported. If a virtual table cannot be resolved, possible backing tables have
`kind: "unknown"` and an explicit limitation; their rows are refused. Unrelated
ordinary tables remain selectable. Schema inventory does not execute views,
triggers or arbitrary SQL.

Rows are optional. `table` selects one exact ordinary-table name. `row_limit`
requires `table`, defaults to 100 and accepts positive safe integers. Samples
remain subject to the byte and worker resource limits below, regardless of row count. The result reports
the selected limit, returned count and whether more rows were observed. Row
order is unspecified; a truncated sample does not prove anything about omitted
records. View, virtual-table and shadow-table row reads are unsupported.

SQLite integers are decimal strings so every signed 64-bit value survives JSON
serialization. Real values retain their numbers; `"Infinity"`, `"-Infinity"`
and `"-0"` explicitly preserve infinities and negative zero through JSON.
Text returns the decoded string together with its bytes as hex and the database
encoding, preserving malformed text that the SQLite binding may replace for
display. Blobs are hex, and SQL NULL is a distinct tagged value.

Database and existing sibling `-wal` files have separate original SHA-256 and
byte counts. The Evidence subject identifies the original database file;
the WAL identity is also necessary to interpret pending committed data. The
SQLite engine version is reported with the observed result. Neither digest is
a claim that the database is healthy, complete or trusted.

## Source files and failures

REA copies the selected database and existing sibling WAL to an owned private
temporary directory before SQLite opens them. Source files are not opened by
SQLite, so its locks or shared-memory sidecars cannot modify the original
snapshot. Temporary copies and the owned worker are cleaned up on success,
failure and cancellation. Extension loading and schema trust are disabled.
Empty rollback journals and fully zeroed journal headers left by successful
`TRUNCATE` and `PERSIST` commits are accepted after stable identity checks.
Other retained rollback journals are refused because recovery is outside this
profile. Journal files are never modified or copied into the worker snapshot.

The database and WAL together are limited to 256 MiB. SQLite values/records,
SQL statements and the complete worker JSON reply each have a 16 MiB limit.
The owned worker has a 256 MiB JavaScript heap limit and a 30-second inspection
deadline. SQLite native allocations are separate from the JavaScript heap;
overall native heap and total resident memory are not capped. Row limits do not
override these byte and resource limits. Resource-limit failures do not return
an incomplete schema as successful complete evidence.

MCP also applies its configured response budget to the complete Evidence
envelope. If delivery exceeds that budget, it reports a transport constraint
with guidance for exporting retained Evidence, requesting a matching larger
client/server response budget or using complete CLI JSON output.

Changed input identities, special files, malformed databases, unsupported
formats and resource failures are reported as errors with the selected path and
meaningful reason. Encrypted databases, database repair, arbitrary SQL,
cross-database queries and live capture are outside this inspection's coverage.
