import { z } from "zod";
import {
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import {
  functionDossierSchema,
  procedureIdentitySchema,
} from "../domain/hopperValues.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";
import type { BinaryNinjaMcp } from "./BinaryNinjaMcp.js";

/** Provider-neutral operations implemented by the read-only MCP adapter. */
export const BINARY_NINJA_OPERATIONS = [
  "address_name",
  "list_documents",
  "list_names",
  "list_procedures",
  "list_segments",
  "list_strings",
  "procedure_address",
  "search_procedures",
  "search_strings",
  "read_bytes",
  "xrefs",
  "procedure_assembly",
  "procedure_pseudo_code",
  "procedure_callers",
  "procedure_callees",
  "procedure_info",
  "read_function_instructions",
  "analyze_function",
] as const;

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-f]+$/iu)
  .transform((value) => `0x${BigInt(value).toString(16)}`);

/** Preserve full-width addresses instead of coercing them through JavaScript numbers. */
export const address = (value: unknown): string => addressSchema.parse(value);

/** Require an explicit canonical address at a REA caller boundary. */
export const inputAddress = (value: unknown, operation: string): string => {
  const parsed = addressSchema.safeParse(value);
  if (!parsed.success)
    throw new AnalysisInputError(operation, { cause: parsed.error }, [
      {
        path: ["address"],
        reason: "invalid_format",
        message: "Supply an explicit 0x-prefixed hexadecimal address.",
      },
    ]);
  return parsed.data;
};

/** Read a provider-authored string field from known equivalent output names. */
export const textField = (
  row: Readonly<Record<string, JsonValue>>,
  ...keys: string[]
): string => {
  for (const key of keys) if (typeof row[key] === "string") return row[key];
  throw new AnalysisOutputError(
    "binary-ninja",
    `Missing string field: ${keys.join("/")}`,
  );
};

/** Normalize an observed function identity without inventing a contiguous body. */
export const functionIdentity = (row: Readonly<Record<string, JsonValue>>) =>
  procedureIdentitySchema.parse({
    address: address(row.start ?? row.address),
    name: textField(row, "name", "symbol", "shortName"),
    body: {
      available: false,
      reason:
        "Binary Ninja MCP function-list bounds do not establish complete owned body ranges.",
    },
  });

/** Read complete inventories locally so REA regex and case semantics stay consistent. */
export const searchRows = (
  rows: readonly Record<string, JsonValue>[],
  input: Readonly<Record<string, JsonValue>>,
  operation: string,
): Record<string, JsonValue>[] => {
  const parsed = z
    .object({
      pattern: z.string().min(1),
      mode: z.enum(["literal", "regex"]).default("literal"),
      case_sensitive: z.boolean().default(false),
    })
    .safeParse(input);
  if (!parsed.success)
    throw new AnalysisInputError(operation, { cause: parsed.error });
  const { pattern, mode, case_sensitive: sensitive } = parsed.data;
  let regex: RegExp | undefined;
  try {
    if (mode === "regex") regex = new RegExp(pattern, sensitive ? "u" : "iu");
  } catch (cause: unknown) {
    throw new AnalysisInputError(operation, { cause });
  }
  return rows.filter((row) => {
    const value = textField(row, "value");
    return (
      regex?.test(value) ??
      (sensitive
        ? value.includes(pattern)
        : value.toLowerCase().includes(pattern.toLowerCase()))
    );
  });
};

/** Project complete named inventories while preserving explicit-address and search semantics. */
export const namedInventory = async (
  mcp: BinaryNinjaMcp,
  operation: string,
  input: Readonly<Record<string, JsonValue>>,
  signal?: AbortSignal,
): Promise<JsonValue> => {
  const role =
    operation === "list_names" || operation === "address_name"
      ? "symbols"
      : "strings";
  const query =
    operation === "address_name" || input.address != null
      ? inputAddress(input.address, operation)
      : undefined;
  const observed = await mcp.list(role, {}, signal);
  const rows = observed.map((row) => ({
    address: address(row.address ?? row.start),
    value:
      role === "symbols"
        ? textField(row, "name", "shortName")
        : textField(row, "value", "text"),
  }));
  if (operation === "search_strings") return searchRows(rows, input, operation);
  const filtered =
    query === undefined ? rows : rows.filter((row) => row.address === query);
  if (operation !== "address_name") return filtered;
  if (filtered.length > 1)
    throw new AnalysisOutputError(
      operation,
      "Multiple symbols match and the primary name is not established by this adapter",
    );
  return filtered[0]?.value ?? null;
};

/** Project observed segment bounds and permissions, leaving missing permission facts unknown. */
export const segmentInventory = async (
  mcp: BinaryNinjaMcp,
  signal?: AbortSignal,
): Promise<JsonValue> =>
  (await mcp.list("segments", {}, signal)).map((row) => ({
    name: typeof row.name === "string" ? row.name : "",
    start: address(row.start),
    end: address(row.end),
    readable: typeof row.readable === "boolean" ? row.readable : null,
    writable: typeof row.writable === "boolean" ? row.writable : null,
    executable: typeof row.executable === "boolean" ? row.executable : null,
  }));

/** Normalize rendered function text, preserving null decompilation explicitly. */
export const renderedText = (
  value: JsonValue,
  kind: "disassembly" | "pseudocode",
): string | null => {
  if (value === null || typeof value === "string") return value;
  const row = jsonObjectSchema.parse(value);
  for (const key of [
    kind,
    "text",
    "code",
    "pseudoC",
    "lines",
    "instructions",
  ]) {
    const found = row[key];
    if (found === null) return null;
    if (typeof found === "string") return found;
    if (Array.isArray(found))
      return found
        .map((line) => {
          if (typeof line === "string") return line;
          const object = jsonObjectSchema.parse(line);
          return `${address(object.address)}  ${textField(object, "text", "instruction")}`;
        })
        .join("\n");
  }
  throw new AnalysisOutputError(
    kind,
    "Binary Ninja omitted rendered function text",
  );
};

/** Byte reads retain measured completeness and fail on contradictory hex/count metadata. */
export const byteResult = (
  value: JsonValue,
  query: string,
  requested: number,
): JsonValue => {
  const row = jsonObjectSchema.parse(value);
  const hex = z
    .string()
    .regex(/^(?:[a-f0-9]{2})*$/iu)
    .parse(row.hex ?? row.bytesHex ?? row.bytes_hex);
  const count = hex.length / 2;
  if (
    count > requested ||
    (row.length !== undefined && row.length !== count) ||
    (row.returnedBytes !== undefined && row.returnedBytes !== count)
  )
    throw new AnalysisOutputError(
      "read_bytes",
      "Binary Ninja byte counts disagree",
    );
  return {
    address: address(row.address ?? query),
    requested_bytes: requested,
    returned_bytes: count,
    bytes_hex: hex.toLowerCase(),
    complete: count === requested,
  };
};

/** Compose one strict REA dossier from the built-in server's read-only function tools. */
export const functionDossier = async (
  mcp: BinaryNinjaMcp,
  row: Readonly<Record<string, JsonValue>>,
  input: Readonly<Record<string, JsonValue>>,
  signal?: AbortSignal,
): Promise<JsonValue> => {
  const identity = functionIdentity(row);
  const pseudocode = renderedText(
    await mcp.call("pseudocode", input, signal),
    "pseudocode",
  );
  const assembly = renderedText(
    await mcp.call("disassembly", input, signal),
    "disassembly",
  );
  const callers = (await mcp.list("callers", input, signal)).map(
    functionIdentity,
  );
  const callees = (await mcp.list("callees", input, signal)).map(
    functionIdentity,
  );
  return jsonValueSchema.parse(
    functionDossierSchema.parse({
      procedure: {
        ...identity,
        signature: typeof row.signature === "string" ? row.signature : null,
        locals: [],
      },
      pseudocode: pseudocode ?? "",
      assembly: assembly === null ? [] : assembly.split("\n"),
      comments: [],
      callers,
      callees,
      incoming_references: [],
      outgoing_references: [],
      referenced_strings: [],
      referenced_names: [],
      basic_blocks: [],
      native_api: null,
      native_value_flow: null,
      limitations: [
        "Pseudocode is Binary Ninja decompiler output, not original source.",
        "Complete body ranges, locals, comments, typed reference edges, referenced strings/names, CFG blocks, and native value flow are not projected by this adapter; empty collections for these facets mean unobserved, not absent.",
        "Callers and callees are resolved static relationships; unresolved indirect calls remain unknown.",
        ...(pseudocode === null
          ? [
              "The server returned null pseudocode; the empty dossier text does not establish a decompilation.",
            ]
          : []),
      ],
    }),
  );
};
