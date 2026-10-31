import { normalize } from "node:path";
import { z } from "zod";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";

/** Normalize a Binary Ninja hexadecimal address without passing through a JavaScript number. */
export const binaryNinjaAddressSchema = z
  .string()
  .regex(/^0x[0-9a-f]+$/iu)
  .transform((value) => `0x${BigInt(value).toString(16)}`);

/** Binary Ninja reports an error result as structured content with a machine-readable code. */
export const binaryNinjaToolErrorSchema = z
  .object({ errorCode: z.string().min(1), errorMessage: z.string() })
  .passthrough();

/**
 * One rendered tool reply: list and function tools return Markdown text with a
 * front-matter header, while view and memory tools return structured content.
 */
export interface BinaryNinjaDocument {
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly body: string;
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n/u;

/**
 * Parse the producer's front-matter header. Every value is a JSON scalar, so a
 * value that is not valid JSON is a producer change rather than a free-form string.
 */
export const parseBinaryNinjaDocument = (
  text: string,
  tool: string,
): BinaryNinjaDocument => {
  const match = FRONT_MATTER.exec(text);
  if (match === null)
    throw new AnalysisProtocolError(
      `Binary Ninja ${tool} omitted its front-matter header.`,
    );
  const metadata: Record<string, JsonValue> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const separator = line.indexOf(": ");
    if (separator <= 0)
      throw new AnalysisProtocolError(
        `Binary Ninja ${tool} returned a malformed front-matter line.`,
      );
    const key = line.slice(0, separator);
    let value: unknown;
    try {
      value = JSON.parse(line.slice(separator + 2));
    } catch (cause: unknown) {
      throw new AnalysisProtocolError(
        `Binary Ninja ${tool} returned a non-JSON front-matter value for ${key}.`,
        { cause },
      );
    }
    if (key in metadata)
      throw new AnalysisProtocolError(
        `Binary Ninja ${tool} repeated front-matter key ${key}.`,
      );
    metadata[key] = jsonValueSchema.parse(value);
  }
  if (metadata.tool !== tool)
    throw new AnalysisProtocolError(
      `Binary Ninja answered ${JSON.stringify(metadata.tool)} for a ${tool} request.`,
    );
  return { metadata, body: text.slice(match[0].length) };
};

/** Pagination fields every list and function-text page reports. */
export const binaryNinjaPageSchema = z
  .object({
    offset: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    nextOffset: z.number().int().positive().nullable(),
    truncated: z.boolean(),
  })
  .passthrough()
  .superRefine((page, context) => {
    const end = page.offset + page.count;
    if (
      end > page.total ||
      (page.nextOffset === null ? end !== page.total : end >= page.total)
    )
      context.addIssue({
        code: "custom",
        message: "page coverage disagrees with total",
      });
    if (page.truncated !== (page.nextOffset !== null))
      context.addIssue({
        code: "custom",
        message: "truncated disagrees with nextOffset",
      });
    if (
      page.nextOffset !== null &&
      page.nextOffset !== page.offset + page.count
    )
      context.addIssue({
        code: "custom",
        message: "nextOffset does not continue the returned page",
      });
  });
export type BinaryNinjaPage = z.infer<typeof binaryNinjaPageSchema>;

/**
 * Split one rendered table row. The producer separates cells with " | " and
 * escapes a literal pipe inside a cell as "\|"; it does not escape backslashes.
 */
const splitRow = (line: string): string[] | undefined => {
  if (line.length < 4 || !line.startsWith("| ") || !line.endsWith(" |"))
    return undefined;
  return line
    .slice(2, -2)
    .split(" | ")
    .map((cell) => cell.replaceAll("\\|", "|"));
};

/**
 * Parse exactly one Markdown table with the expected columns. An absent or
 * reordered column is a producer change, never an empty observation.
 */
export const parseBinaryNinjaTable = (
  body: string,
  columns: readonly string[],
  tool: string,
): Record<string, string>[] => {
  const lines = body.split("\n").filter((line) => line.length > 0);
  const header = splitRow(lines[0] ?? "");
  if (
    header === undefined ||
    header.length !== columns.length ||
    header.some((name, index) => name !== columns[index])
  )
    throw new AnalysisProtocolError(
      `Binary Ninja ${tool} returned unexpected table columns; expected ${columns.join(", ")}.`,
    );
  const separator = splitRow(lines[1] ?? "");
  if (
    separator === undefined ||
    separator.length !== columns.length ||
    separator.some((cell) => cell !== "---")
  )
    throw new AnalysisProtocolError(
      `Binary Ninja ${tool} omitted its table separator.`,
    );
  return lines.slice(2).map((line) => {
    const cells = splitRow(line);
    if (cells?.length !== columns.length)
      throw new AnalysisProtocolError(
        `Binary Ninja ${tool} returned a row whose width disagrees with its columns.`,
      );
    return Object.fromEntries(
      columns.map((column, index) => [column, cells[index] ?? ""]),
    );
  });
};

/** Extract the single fenced block a function-text tool renders, without reinterpretation. */
export const parseBinaryNinjaCodeBlock = (
  body: string,
  languages: readonly string[],
  tool: string,
): string[] => {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.startsWith("````"));
  const language = start < 0 ? undefined : lines[start]?.slice(4);
  if (language === undefined || !languages.includes(language))
    throw new AnalysisProtocolError(
      `Binary Ninja ${tool} omitted its ${languages.join("/")} code block.`,
    );
  const end = lines.indexOf("````", start + 1);
  if (end < 0)
    throw new AnalysisProtocolError(
      `Binary Ninja ${tool} returned an unterminated code block.`,
    );
  if (lines.slice(end + 1).some((line) => line.length > 0))
    throw new AnalysisProtocolError(
      `Binary Ninja ${tool} returned content after its code block.`,
    );
  return lines.slice(start + 1, end);
};

/** One function reference rendered as "name (0xADDRESS (arch))". */
export interface BinaryNinjaFunctionReference {
  readonly name: string;
  readonly address: string;
  readonly architecture: string;
}

const REFERENCE_SUFFIX = / \((0x[0-9a-f]+) \(([A-Za-z0-9_.-]+)\)\)(?:, |$)/gu;

/**
 * Parse a cell listing zero or more functions. The address-and-architecture
 * suffix terminates each entry, so names may contain commas and parentheses.
 */
export const parseBinaryNinjaFunctionReferences = (
  cell: string,
  tool: string,
): BinaryNinjaFunctionReference[] => {
  if (cell.length === 0) return [];
  const references: BinaryNinjaFunctionReference[] = [];
  let start = 0;
  for (const match of cell.matchAll(REFERENCE_SUFFIX)) {
    const name = cell.slice(start, match.index);
    if (name.length === 0)
      throw new AnalysisProtocolError(
        `Binary Ninja ${tool} returned an unnamed function reference.`,
      );
    references.push({
      name,
      address: binaryNinjaAddressSchema.parse(match[1]),
      architecture: match[2] ?? "",
    });
    start = match.index + match[0].length;
  }
  if (start !== cell.length)
    throw new AnalysisProtocolError(
      `Binary Ninja ${tool} returned an unrecognized function reference: ${cell}`,
    );
  return references;
};

/** One BinaryView as reported by view tools. */
export const binaryNinjaViewSchema = z
  .object({
    handle: z.string().min(1),
    openItem: z.string().min(1),
    viewType: z.string().min(1),
    architecture: z.string(),
    platform: z.string(),
    start: binaryNinjaAddressSchema,
    end: binaryNinjaAddressSchema,
    entryPoint: binaryNinjaAddressSchema,
    modified: z.boolean(),
    analysisModified: z.boolean(),
  })
  .passthrough();
export type BinaryNinjaView = z.infer<typeof binaryNinjaViewSchema>;

export const binaryNinjaActiveViewSchema = z
  .object({ binaryView: binaryNinjaViewSchema.nullable() })
  .passthrough();

export const binaryNinjaSetActiveSchema = z
  .object({ binaryView: binaryNinjaViewSchema, changed: z.boolean() })
  .passthrough();

export const binaryNinjaMemoryReadSchema = z
  .object({
    address: binaryNinjaAddressSchema,
    bytesRead: z.number().int().nonnegative(),
    hex: z.string().regex(/^(?:[0-9a-f]{2})*$/iu),
  })
  .passthrough()
  .refine((read) => read.hex.length === read.bytesRead * 2, {
    path: ["hex"],
    message: "Binary Ninja memory hex must contain exactly bytesRead bytes.",
  });

export const binaryNinjaAnalysisStatusSchema = z
  .object({
    analysis: z.object({ state: z.string().min(1) }).passthrough(),
  })
  .passthrough();

/** Columns of each table-rendering tool, in producer order. */
export const BINARY_NINJA_COLUMNS = {
  bn_open_item_list: [
    "openItem",
    "kind",
    "displayName",
    "path",
    "projectPath",
    "sessionId",
    "modified",
    "analysisModified",
    "saveable",
    "databaseBacked",
    "validSavePath",
  ],
  bn_binary_view_list: [
    "binaryView",
    "openItem",
    "viewType",
    "longName",
    "created",
    "active",
    "available",
    "recommended",
    "architecture",
    "platform",
    "addressSize",
    "start",
    "end",
    "entryPoint",
    "modified",
    "analysisModified",
  ],
  bn_function_list: [
    "function",
    "arch",
    "name",
    "platform",
    "lowestAddress",
    "highestAddress",
    "definition",
    "basicBlockCount",
    "exported",
    "autoDiscovered",
  ],
  bn_function_search: [
    "function",
    "arch",
    "name",
    "platform",
    "lowestAddress",
    "highestAddress",
    "definition",
    "basicBlockCount",
    "exported",
    "autoDiscovered",
  ],
  bn_string_list: [
    "string",
    "type",
    "length",
    "previewEscaped",
    "previewHex",
    "previewTruncated",
  ],
  bn_function_callers: ["Callsite", "Architecture", "Caller Function"],
  bn_function_callees: [
    "Callsite",
    "Architecture",
    "Callee Address",
    "Callee Functions",
  ],
  bn_function_xrefs_to: [
    "Source",
    "Architecture",
    "Source Function",
    "Target Range",
  ],
  bn_data_xrefs_to: ["Source", "Source Data Variable", "Source Definition"],
  bn_symbol_list_at: [
    "symbol",
    "name",
    "type",
    "namespace",
    "ordinal",
    "binding",
    "fullName",
    "autoDefined",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;
export type BinaryNinjaTableTool = keyof typeof BINARY_NINJA_COLUMNS;

/** Compare a producer path with a host path; Binary Ninja renders Windows paths with "/". */
export const sameBinaryNinjaHostPath = (
  producer: string,
  host: string,
): boolean =>
  process.platform === "win32"
    ? normalize(producer).toLowerCase() === normalize(host).toLowerCase()
    : normalize(producer) === normalize(host);
