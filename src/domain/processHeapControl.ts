/**
 * Node control for the CLI/MCP process heap. Admissions that run in that
 * process (not in an isolated worker) name this control in their recovery.
 * The old-space flag requires a mebibyte value; a bare name is an illegal V8
 * option and prevents Node from starting.
 */
export const PARENT_HEAP_NODE_OPTIONS =
  "On Node, set NODE_OPTIONS (for example --max-old-space-size=<MiB>) in the environment that starts the CLI or MCP server, then restart that process,";
