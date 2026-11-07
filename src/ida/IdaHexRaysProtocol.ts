import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import type { IdaMcpConnection } from "./IdaMcpConnection.js";
import type { IdaRawObservation } from "./IdaOperationRunner.js";

/** The official Hex-Rays IDA MCP catalog this profile requires. */
export const hexRaysTools = [
  "open_database",
  "list_databases",
  "close_database",
  "execute_python",
];

/** Database-supervisor reads that REA's fixed query bridge answers. */
const hexRaysQueries: ReadonlySet<string> = new Set([
  "server_health",
  "list_funcs",
  "lookup_funcs",
  "find_regex",
  "decompile",
  "disasm",
  "callees",
  "callgraph",
  "xrefs_to",
  "survey_binary",
]);

export const hexRaysOpenSchema = z
  .object({
    instance_id: z.string().min(1),
    backend: z.enum(["gui", "idalib"]),
    status: z.string(),
  })
  .passthrough();

/** Inventory rows; `instance_id` is null for databases this server holds no lease on. */
export const hexRaysListSchema = z
  .object({
    instances: z.array(
      z
        .object({
          path: z.string(),
          backend: z.enum(["gui", "idalib"]),
          status: z.enum(["available", "attached", "current", "unavailable"]),
          instance_id: z.string().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const hexRaysCloseSchema = z
  .object({ closed: z.literal(true) })
  .passthrough();

const executionSchema = z
  .object({ result: jsonValueSchema, stdout: z.string(), stderr: z.string() })
  .passthrough();

let querySource: { readonly code: string; readonly sha256: string } | undefined;
const queryBridge = () => {
  if (querySource !== undefined) return querySource;
  const code = readFileSync(
    fileURLToPath(
      new URL("../../bridge/ida/hexrays_queries.py", import.meta.url),
    ),
    "utf8",
  );
  querySource = {
    code,
    sha256: createHash("sha256").update(code).digest("hex"),
  };
  return querySource;
};

/**
 * Answer one database-supervisor read through `execute_python` with REA's
 * fixed, read-only query bridge. Only the query name and its JSON arguments
 * vary; caller text never becomes Python source. The observation records the
 * actual upstream tool and the bridge digest instead of the bridge body.
 */
export const runHexRaysQuery = async (
  connection: IdaMcpConnection,
  instanceId: string,
  query: string,
  args: Readonly<Record<string, JsonValue>>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IdaRawObservation> => {
  if (!hexRaysQueries.has(query))
    throw new AnalysisProtocolError(
      `The Hex-Rays IDA MCP profile does not implement ${query}.`,
    );
  // The lease is selected by instance_id; the supervisor `database` argument has no bridge meaning.
  const { database: _database, ...queryArguments } = args;
  const bridge = queryBridge();
  const raw = await connection.call(
    "execute_python",
    {
      instance_id: instanceId,
      // A JSON string literal is also a valid Python string literal.
      code: `${bridge.code}\n_rea_query(${JSON.stringify(query)}, ${JSON.stringify(JSON.stringify(queryArguments))})`,
      // Leave the engine deadline inside the request deadline, so upstream
      // can stop the script and answer before REA abandons the request.
      timeout: Math.max(1, Math.floor(timeoutMs / 1000) - 5),
    },
    { timeoutMs, ...(signal === undefined ? {} : { signal }) },
  );
  const execution = executionSchema.parse(raw);
  return {
    tool: "execute_python",
    arguments: {
      instance_id: instanceId,
      query,
      query_arguments: queryArguments,
      bridge_sha256: bridge.sha256,
    },
    result: execution.result,
    ...(execution.stdout === "" && execution.stderr === ""
      ? {}
      : { output: { stdout: execution.stdout, stderr: execution.stderr } }),
  };
};
