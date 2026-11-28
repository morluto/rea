# Design Proposal: Read-Only PostgreSQL Database Inspection

- **Issue Reference**: [#6211](https://github.com/morluto/rea/issues/6211)
- **Proposed Operation**: `inspect_postgresql_database` / `rea inspect-postgresql-database`
- **Category**: Database and Application Storage Analysis
- **Status**: Proposed (Design RFC & Maintainer Scope Review)
- **Scope Authority**: Strictly Read-Only, No Mutation, No Arbitrary SQL Execution

---

## 1. Executive Summary & Analyst Question

### 1.1 Motivation

Reverse engineering complex desktop, enterprise, containerized, and client-server software frequently requires inspecting persistent relational state. Application databases contain authorization models, role definitions, session tokens, cryptographic parameters, configuration flags, workflow states, and data schemas that explain reverse-engineered binary logic or obfuscated application workflows.

REA currently provides [`inspect_sqlite_database`](../sqlite-databases.md) for offline, file-based SQLite database snapshots. However, applications backed by PostgreSQL databases cannot be inspected using SQLite file semantics.

This proposal defines a dedicated, read-only PostgreSQL database inspection tool (`inspect_postgresql_database`) for REA. It enables agents and analysts to connect to an explicitly caller-selected PostgreSQL target, examine schema inventories, and sample bounded table records directly within the investigation conversation, preserving structured [Evidence](../mcp-contracts.md) and strict execution boundaries.

### 1.2 Analyst Questions

The tool is designed to answer:

1. **Schema Discovery**: _"What schemas, tables, views, and data structures are defined in this PostgreSQL database?"_
2. **Column & Constraint Inspection**: _"What are the exact data types, nullability rules, primary keys, foreign keys, and indexes for selected tables?"_
3. **Target Data Sampling**: _"What concrete records or configurations exist in caller-selected tables and columns to clarify the behavior observed in decompiled code or network captures?"_

---

## 2. Scope Boundaries & Security Model (Fail-Closed Integration)

In accordance with REA's [contribution scope and fail-closed integration rule](https://github.com/morluto/rea/blob/main/CONTRIBUTING.md#fail-closed-integration), network-facing inspection capabilities must establish unambiguous security, authority, and lifecycle boundaries before integration.

### 2.1 Absolute Zero-Mutation Authority

1. **No Arbitrary SQL Input**: The tool **never** accepts caller-supplied SQL strings, execution scripts, or expressions. All queries issued by REA are fixed, pre-audited catalog queries and parameterized projections.
2. **No DDL or DML**: Commands such as `CREATE`, `DROP`, `ALTER`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `GRANT`, `REVOKE`, or `CALL`/`DO` are neither exposed nor permitted.
3. **Read-Only Transaction Isolation**:
   - Every connection immediately executes:
     ```sql
     SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;
     ```
   - All operations execute within an explicit `BEGIN TRANSACTION READ ONLY;` block.
   - Upon completion or failure, connections unconditionally issue `ROLLBACK;`. No changes are ever committed.
4. **Least-Privilege Role Contract**:
   - REA documentation and diagnostic hints instruct operators to provide a dedicated, unprivileged read-only role:
     ```sql
     CREATE ROLE rea_reader WITH LOGIN PASSWORD '...';
     GRANT CONNECT ON DATABASE target_db TO rea_reader;
     GRANT USAGE ON SCHEMA public TO rea_reader;
     GRANT SELECT ON ALL TABLES IN SCHEMA public TO rea_reader;
     ```
5. **Row Sampling Restricted Exclusively to Ordinary Base Tables**:
   - In Phase 1, data sampling via `table` selection is strictly restricted to ordinary base tables (`table_type = 'BASE TABLE'` / `relkind = 'r'`).
   - Views (`relkind = 'v'`), materialized views (`relkind = 'm'`), and foreign tables (`relkind = 'f'`) are included in the schema catalog inventory (definitions, columns, types), but attempting to sample their rows is refused upfront as `capability_unavailable` (`view_sampling_unsupported`).
   - _Rationale_: Even within a read-only transaction, evaluating views or foreign tables can invoke user-defined functions with side effects (such as writing to external databases via `dblink` or foreign data wrappers, triggering external HTTP calls, or executing autonomous procedures). Rolling back the inspection connection cannot undo out-of-band writes performed by such functions. Restricting row reads to ordinary base tables guarantees true zero-mutation without expanding execution authority.

### 2.2 Network Topology & Endpoint Boundaries

- **Loopback Default (Phase 1)**: By default, the provider restricts connections to loopback interfaces (`localhost`, `127.0.0.1`, `::1`) and Unix domain sockets (`/var/run/postgresql/` or `/tmp/`). This aligns with REA's local-only analysis posture (such as inspecting a local development target or container whose port is published to localhost).
- **Remote Host Boundary (Maintainer Scope Decision)**:
  - If remote host inspection is enabled, it must be explicitly declared by the operator via input parameters.
  - **SSRF Prevention**: The provider validates hostnames and IP addresses against restricted networks:
    - Link-local and cloud metadata endpoints (e.g., `169.254.169.254`, `fd00::/8`) are unconditionally blocked.
    - Private RFC 1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) require explicit caller admission (`allow_private_network: true`).
- **Port Constraints**: Bounded to valid unprivileged TCP ports (`1024..65535`), with default `5432`. Privileged system ports (`< 1024`) are rejected upfront by input schema validation.

### 2.3 Credential Redaction & Secret Isolation

Per REA repository guidelines:

> _"Preserve caller-selected inputs and local evidence... Redact transport authentication credentials and explicitly marked sensitive values; do not infer secrecy from names or text patterns."_

1. **Credentials Out of MCP Arguments**: Passwords are **never** accepted as MCP tool arguments or logged in tool invocation parameters.
2. **Credential Discovery Channels**:
   - Environment variables: Standard `PGPASSWORD`, `PGPASSFILE`, or `PGSERVICE`.
   - Out-of-band secret configuration: REA runtime configuration or secret store reference.
3. **URL & Logging Redaction**:
   - If a connection URI is provided in configuration (e.g., `DATABASE_URL`), it is sanitized immediately upon admission:
     `postgresql://analyst:secret@127.0.0.1:5432/app` $\to$ `postgresql://analyst:***@127.0.0.1:5432/app`.
   - The redacted URI is used for all Evidence records, session transcripts, diagnostics, and CLI output.

---

## 3. Tool Contract & Schema Design

Following [`docs/tool-design.md`](../tool-design.md), the tool follows the `inspect` shape: reporting facts about one explicitly selected database target.

### 3.1 Public Tool Identity

- **MCP Tool Name**: `inspect_postgresql_database`
- **CLI Command**: `rea inspect-postgresql-database`

### 3.2 Input Contract (Zod Schema Definition)

```typescript
import { z } from "zod";

export const inspectPostgresqlDatabaseInputSchema = z.strictObject({
  /** Database name to inspect (required). */
  database: z.string().min(1).max(63),

  /** Target host or socket path (defaults to "127.0.0.1"). */
  host: z.string().default("127.0.0.1"),

  /** TCP port number (1024..65535, defaults to 5432). Privileged system ports (<1024) are rejected by admission. */
  port: z.number().int().min(1024).max(65535).default(5432),

  /** Target schema name (defaults to "public"; pass "*" to inspect all user schemas). */
  schema_name: z.string().min(1).max(63).default("public"),

  /**
   * Scope of schema inspection:
   * - "inventory": Compact list of tables, views, and estimates (default when table is omitted).
   * - "selected_table": Deep inspection of the selected table's columns, indexes, and constraints.
   * - "database": Complete schema dump including all table declarations and columns across requested schema(s).
   */
  schema_scope: z.enum(["inventory", "selected_table", "database"]).optional(),

  /**
   * Exact ordinary base table name to inspect and sample.
   * Views, materialized views, and foreign tables appear in schema inventory, but row sampling is refused.
   * Resolution:
   * - When schema_name is "public" (default) or an explicit single schema, resolves in that schema.
   * - When schema_name is "*" and multiple schemas contain a table of this name, the request is
   *   refused upfront as an ambiguous input (AnalysisInputError, "ambiguous_table_name").
   */
  table: z.string().min(1).max(63).optional(),

  /** Specific visible column names to project in sample. If omitted, projects all readable columns up to limit. */
  columns: z.array(z.string().min(1).max(63)).min(1).max(100).optional(),

  /** Maximum rows to sample (default: 20, max: 100). */
  row_limit: z.number().int().positive().max(100).default(20),

  /** TLS/SSL connection mode. */
  ssl_mode: z
    .enum(["disable", "prefer", "require", "verify-ca", "verify-full"])
    .default("prefer"),
});

export type InspectPostgresqlDatabaseInput = z.infer<
  typeof inspectPostgresqlDatabaseInputSchema
>;
```

### 3.3 Output Result Contract

```typescript
/** Scalar value representation for PostgreSQL cells. */
export type PostgresqlScalarValue =
  | null
  | boolean
  | number // int2, int4, float4, float8 within safe integer / finite range
  | string; // int8 (bigint), numeric/decimal, uuid, ISO date/timestamp, bytea hex ("\x..."), "Infinity", "-Infinity", "NaN"

/**
 * Composite, array, or JSON cell representation.
 * SQL NULL maps to null. Arrays map to nested arrays of PostgresqlValue.
 * JSON/JSONB maps to validated parsed JSON objects/arrays or stringified JSON text.
 */
export type PostgresqlValue =
  | PostgresqlScalarValue
  | { [key: string]: unknown }
  | PostgresqlValue[];

export interface PostgresqlDatabaseInspection {
  /** Target server identity and dialect version. */
  server: {
    host: string;
    port: number;
    database: string;
    server_version: string;
    server_version_num: number;
    protocol_version: number;
    ssl: boolean;
  };

  /** Schema catalog evidence. */
  schema: {
    completeness: "inventory" | "selected_table" | "database";
    tables: Array<{
      schema: string;
      name: string;
      kind:
        | "table"
        | "view"
        | "materialized_view"
        | "foreign_table"
        | "partitioned_table";
      row_estimate: number | null; // From pg_class.reltuples, annotated as estimate
      comment: string | null;
    }>;
    columns?: Array<{
      schema: string;
      table: string;
      name: string;
      position: number;
      data_type: string;
      udt_name: string;
      is_nullable: boolean;
      column_default: string | null;
      is_identity: boolean;
      is_generated: boolean;
    }>;
    primary_keys?: Array<{
      schema: string;
      table: string;
      constraint_name: string;
      columns: string[];
    }>;
    foreign_keys?: Array<{
      schema: string;
      table: string;
      constraint_name: string;
      columns: string[];
      foreign_schema: string;
      foreign_table: string;
      foreign_columns: string[];
    }>;
    indexes?: Array<{
      schema: string;
      table: string;
      name: string;
      is_unique: boolean;
      is_primary: boolean;
      definition: string;
    }>;
  };

  /** Bounded row sample (present only when `table` is selected). */
  sample?: {
    schema: string;
    table: string;
    columns: string[];
    rows: Array<Array<PostgresqlValue>>;
    row_count: number;
    row_limit: number;
    has_more: boolean;
    truncated_cells: Array<{
      row: number;
      column: string;
      original_bytes: number;
    }>;
  };

  /** Operational coverage, limitations, and truncation facts. */
  coverage: {
    examined_schemas: string[];
    omitted_schemas: string[]; // e.g., ["pg_catalog", "information_schema", "pg_toast"]
    limitations: string[];
  };
}
```

---

## 4. Evidence Semantics & Type Representation

REA preserves Evidence provenance and clearly categorizes analytical knowledge:

| Fact Type       | Source in PostgreSQL Provider                                                                                                                                  | Epistemic Status |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------- |
| **Observation** | Catalog rows from `pg_catalog.pg_class`, `pg_attribute`, `information_schema.columns`; literal cell bytes/values returned from projection queries.             | Empirical Fact   |
| **Derivation**  | Table cardinality derived from `pg_class.reltuples` (annotated as _estimate_, avoiding expensive full table `COUNT(*)` scans); Foreign key dependency graphs.  | Computed Value   |
| **Inference**   | None. REA does not infer application-level domain constraints or ORM relationships from column naming patterns.                                                | Unsupported      |
| **Unknown**     | Columns marked dropped (`attisdropped`), tables in inaccessible schemas, unselected rows past `row_limit`, binary extension types without registered decoders. | Explicit Unknown |

### 4.1 JSON-Safe Data Type Serialization

To ensure lossless JSON serialization and avoid agent hallucination from formatting anomalies, types are mapped consistently with `inspect_sqlite_database`:

1. **SQL NULL**: Emitted strictly as JSON `null`.
2. **64-bit Integers (`bigint`, `int8`)**: Emitted as decimal strings (`"9223372036854775807"`) to prevent IEEE-754 precision loss in JSON parsers.
3. **Arbitrary Precision (`numeric`, `decimal`)**: Emitted as decimal strings (`"123456789.987654321"`).
4. **Small/Standard Integers & Floats (`int2`, `int4`, `float4`, `float8`)**: Emitted as standard JSON numbers. Special floats are preserved as strings: `"Infinity"`, `"-Infinity"`, and `"NaN"`.
5. **Binary Data (`bytea`)**: Represented as hex-encoded strings with `\x` prefix. Capped at cell byte budget (default: 4 KiB); oversized values are truncated at the wire level with cell truncation metadata.
6. **JSON/JSONB**: Parsed with a safe parser preserving numeric precision (large numbers remain strings) into valid JSON objects, or retained as source string if formatting contains extension-specific tokens.
7. **Arrays**: Decoded recursively into nested JSON arrays matching PostgreSQL array dimensions, with elements typed according to `PostgresqlScalarValue`. An empty array is represented as `[]`.
8. **Date & Timestamp (`timestamp`, `timestamptz`, `date`, `time`)**: Emitted as standardized ISO-8601 strings.
9. **Spatial & Extension Types (`geometry`, `vector`, `hstore`)**: Formatted as canonical text representations (e.g. WKT or vector arrays) with extension provenance attached in limitations.
10. **Large Objects (`OID`, `pg_largeobject`)**: The OID is reported as a numerical reference. Large object contents are **not** automatically streamed, protecting memory limits.

---

## 5. Resource Limits, Lifecycles & Error Algebra

Following [`docs/design/limits-and-recovery.md`](./limits-and-recovery.md):

### 5.1 Admission Ceilings & Enforcements

- **Connection Handshake Deadline**: 5,000 ms. If TCP connect or authentication does not settle within 5 seconds, aborts with `AnalysisCapabilityUnavailableError`.
- **Query / Statement Deadline**: 10,000 ms. Enforced both at the client driver level via cancellation timers and on the server via `SET statement_timeout = '10000';`.
- **Row Budget**: Default: 20 rows. Maximum: 100 rows.
- **Wire-Protocol In-Flight Streaming Bounds**:
  - The 2 MiB aggregate response ceiling is enforced before buffering or decoding database representations in memory.
  - _Header-length inspection before buffer allocation_: In PostgreSQL Frontend/Backend Protocol v3.0, the `DataRow` message declares the exact byte length of each column value in its header before payload bytes are transmitted.
  - _In-flight cell truncation_: If an individual cell's declared length exceeds the cell ceiling (4 KiB for `bytea` / 16 KiB for `text`, `varchar`, or `json`), the decoder reads up to the limit, marks the cell truncated with `{ row: number, column: string, original_bytes: number }`, and discards the remaining bytes directly from the network socket stream without buffering them into Node.js heap memory.
  - _Cumulative payload cutoff_: The decoder tracks cumulative transferred payload bytes. If the cumulative uncompressed payload reaches 2 MiB, the query consumer immediately closes the row stream, issues an asynchronous cancel packet (`CancelRequest`) to terminate the backend query, and marks the result partial (`has_more: true`, `coverage.limitations: ["response_byte_budget_exceeded"]`).
- **Column Projection Ceiling**: Maximum 100 projected columns per query. If a table has more than 100 columns and no explicit projection is specified, or if more than 100 columns are selected, queries are refused upfront with `AnalysisResourceConstraintError` before dispatching the `SELECT` query.

### 5.2 Connection & Socket Lifecycle

- **Zero Dangling Connections**: Every inspection operation owns its connection lifecycle from handshake to teardown. Connections are **never** left idling in background pools without an active analysis owner.
- **Unconditional Release**: Teardown occurs in a `finally` block. Upon caller abort signal (`AbortSignal`), the underlying socket is immediately destroyed (`socket.destroy()`).
- **Worker Isolation**: In accordance with REA's supervision primitives (`src/process/`), heavy database communication and decoding can execute within a dedicated worker child process to protect the main MCP server from native crashes or memory leaks.

### 5.3 Tagged Error Algebra

Errors adhere to REA's standard tagged error taxonomy:

| Failure Scenario                                 | Error Class                          | Error Category / Reason |
| :----------------------------------------------- | :----------------------------------- | :---------------------- |
| Database or host unreachable, connection refused | `AnalysisCapabilityUnavailableError` | `connection_refused`    |
| TCP handshake or statement execution timeout     | `AnalysisResourceConstraintError`    | `timeout`               |
| Authentication failure, password rejected        | `AnalysisCapabilityUnavailableError` | `authentication_failed` |
| Caller lacks `CONNECT` or `SELECT` privilege     | `AnalysisCapabilityUnavailableError` | `permission_denied`     |
| Selected schema, table, or column does not exist | `AnalysisInputError`                 | `target_not_found`      |
| Attempt to select more than 100 columns          | `AnalysisResourceConstraintError`    | `capacity`              |
| PostgreSQL server version < 12                   | `AnalysisCapabilityUnavailableError` | `unsupported_version`   |

---

## 6. Implementation Architecture & Driver Strategy

### 6.1 Architecture Layers (Inward Dependency Flow)

Following [REA Architecture](https://github.com/morluto/rea/blob/main/docs/architecture.mermaid):

```
src/domain/postgresql/          <- Pure types, Zod schemas, SQL query templates, type serializers
src/contracts/postgresql/       <- MCP and CLI contract definitions
src/postgresql/                 <- Provider adapter, connection lifecycle, wire protocol execution
src/application/postgresql/     <- Application service and ports
src/cli/postgresqlCommands.ts   <- CLI command registration and table rendering
src/server/registerPostgresql.ts<- MCP tool registration
```

### 6.2 Driver Selection Tradeoff

Three technical approaches were evaluated for the PostgreSQL connection layer:

1. **Option A: Pure TypeScript Wire Protocol Driver (Recommended for REA)**:
   - Implement a lightweight, focused PostgreSQL Frontend/Backend Protocol v3.0 client using Node.js `node:net` and `node:tls`.
   - _Advantages_: Zero external runtime dependencies, minimal bundle size, absolute control over memory allocation and socket teardown, no third-party supply chain risks.
   - _Tradeoffs_: Requires implementing MD5/SCRAM-SHA-256 client authentication handshakes.

2. **Option B: Isolated Subprocess Worker with `pg` (node-postgres)**:
   - Run an isolated child process using the established `pg` driver.
   - _Advantages_: Mature protocol support, comprehensive authentication handling.
   - _Tradeoffs_: Increases package dependencies, requires managing IPC serialization between worker and host.

3. **Option C: External `psql` CLI Subprocess**:
   - Wrap the host's `psql` executable.
   - _Rejected_: Violates REA invariants. Non-portable (psql is not universally installed), fragile output parsing, potential shell injection risks, and poor programmatic Evidence capture.

---

## 7. Verification & Conformance Plan

Before merging into official distributions, the provider must be validated against real targets per [`docs/testing.md`](../testing.md):

### 7.1 Automated Test Fixture

- A disposable, self-owned PostgreSQL container (e.g., `postgres:16-alpine`) running in CI and local test harnesses.
- Configured with predefined schemas:
  - Standard test tables with varying types (integers, strings, dates, arrays, JSONB, bytea, UUID).
  - Foreign key hierarchies and composite primary keys.
  - Large tables ($> 10,000$ rows) to verify `reltuples` estimation and strict `row_limit` cutoff.
  - Multi-schema isolation (`public`, `secret_schema`, `audit_schema`).

### 7.2 Test Suite Matrix

1. **Unit Tests (`src/domain/postgresql/`)**:
   - Identifier escaping verification (ensuring SQL injection resistance on table and column names).
   - Data type decoders and JSON serialization (handling `BigInt`, `Infinity`, `NaN`, `bytea`).
   - Credential redaction filters on URLs and diagnostic messages.
2. **Boundary Tests (`tests/boundary/postgresql/`)**:
   - Connection failure tests: Unreachable IP, closed port, DNS resolution failure.
   - Authentication tests: Invalid password, non-existent user, role missing `CONNECT` permission.
   - Statement timeout tests: Querying `pg_sleep(15)` to verify 10-second ceiling.
   - Resource constraint tests: Projecting $> 100$ columns, fetching oversized bytea cells.
   - Cancellation tests: Aborting `AbortController` during query execution and verifying socket release.
3. **Acceptance & CLI Tests (`tests/acceptance/postgresql/`)**:
   - CLI table output formatting in terminal.
   - MCP tool invocation and structured Evidence envelope generation.
   - Schema scope tests (`inventory` vs `selected_table` vs `database`).

---

## 8. Maintainer Decisions Needed Before Integration

To resolve the open questions in [#6211](https://github.com/morluto/rea/issues/6211):

1. **Network Service Boundary**: Does REA authorize connecting to network-bound database services, or should Phase 1 be strictly gated to loopback / localhost sockets?
2. **Driver Packaging**: Does maintainership prefer a zero-dependency pure-TypeScript wire protocol adapter (Option A) or an isolated worker process leveraging `pg` (Option B)?
3. **Remote Target Policy**: If remote targets are supported in the future, should explicit operator confirmation flags (`--allow-remote`) be mandatory?
