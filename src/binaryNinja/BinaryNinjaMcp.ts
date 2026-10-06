import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";

/** Configured local connection to Binary Ninja's built-in MCP server. */
export type BinaryNinjaMcpConfig = NonNullable<AppConfig["binaryNinjaMcp"]>;
/** Production transport seam; tests use the same SDK over in-memory or HTTP transports. */
export type BinaryNinjaTransportFactory = (
  config: BinaryNinjaMcpConfig,
) => Transport;

const toolNames = {
  open: /^(?:bn_(?:file_open|open_file|open_item_open))$/u,
  close: /^bn_open_item_close$/u,
  views: /^bn_binary_view_list$/u,
  activate: /^bn_binary_view_set_active$/u,
  analyze: /^bn_analysis_(?:update_and_wait|update_wait|analyze_and_wait)$/u,
  functions: /^bn_functions?_list$/u,
  symbols: /^bn_symbols?_list$/u,
  strings: /^bn_strings?_list$/u,
  segments: /^bn_segments?_list$/u,
  info: /^bn_function_(?:get|info|metadata)$/u,
  disassembly: /^bn_function_(?:disassembly|disassemble)$/u,
  pseudocode: /^bn_function_(?:pseudo_c|pseudoc|pseudocode|decompile)$/u,
  callers: /^bn_function_callers$/u,
  callees: /^bn_function_callees$/u,
  xrefs: /^bn_(?:(?:address|code|binary_view)_)?(?:xrefs|references)$/u,
  bytes: /^bn_(?:memory_read|binary_view_read|read_bytes)$/u,
} as const;

const roles = [
  "open",
  "close",
  "views",
  "activate",
  "analyze",
  "functions",
  "symbols",
  "strings",
  "segments",
  "info",
  "disassembly",
  "pseudocode",
  "callers",
  "callees",
  "xrefs",
  "bytes",
] as const;

/** Semantic roles resolved only against tools actually advertised by the server. */
export type BinaryNinjaToolRole = keyof typeof toolNames;

/** Create an owned stdio transport or authenticated loopback HTTP connection. */
export const createBinaryNinjaTransport: BinaryNinjaTransportFactory = (
  config,
) => {
  if (config.url !== undefined) {
    const headers =
      config.token === undefined
        ? {}
        : { Authorization: `Bearer ${config.token}` };
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers, redirect: "error" },
    });
  }
  if (config.command === undefined)
    throw new TypeError("Binary Ninja MCP is not configured");
  return new StdioClientTransport({
    command: config.command,
    args: [...config.args],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    stderr: "ignore",
  });
};

/** SDK-backed MCP connection with advertised-tool checks and complete pagination. */
export class BinaryNinjaMcp {
  readonly client = new Client({ name: "rea-binary-ninja", version: "1" });
  readonly #tools = new Map<BinaryNinjaToolRole, Tool>();
  readonly raw: JsonValue[] = [];
  #connected = false;

  constructor(
    readonly config: BinaryNinjaMcpConfig,
    private readonly transportFactory: BinaryNinjaTransportFactory = createBinaryNinjaTransport,
  ) {}

  /** Initialize MCP and discover the installed server's complete tool inventory. */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#connected) return;
    await this.client.connect(
      this.transportFactory(this.config),
      this.options(signal),
    );
    const tools: Tool[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await this.client.listTools(
        cursor === undefined ? {} : { cursor },
        this.options(signal),
      );
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor !== undefined && cursors.has(cursor))
        throw new AnalysisOutputError(
          "health",
          "Binary Ninja repeated a tools/list cursor",
        );
      if (cursor !== undefined) cursors.add(cursor);
    } while (cursor !== undefined);
    for (const role of roles) {
      const pattern = toolNames[role];
      const matching = tools.filter((tool) => pattern.test(tool.name));
      if (matching.length > 1)
        throw new AnalysisOutputError(
          "health",
          `Ambiguous Binary Ninja tool role ${role}: ${matching.map(({ name }) => name).join(", ")}`,
        );
      const tool = matching[0];
      if (tool !== undefined) this.#tools.set(role, tool);
    }
    for (const role of [
      "open",
      "close",
      "views",
      "activate",
      "analyze",
      "functions",
    ] as const)
      this.tool(role);
    this.#connected = true;
  }

  /** Resolve one version-dependent semantic role without sending guessed tool names. */
  tool(role: BinaryNinjaToolRole): Tool {
    const tool = this.#tools.get(role);
    if (tool === undefined)
      throw new AnalysisCapabilityUnavailableError(
        "binary-ninja",
        role,
        `The server does not advertise a recognized ${role} tool. Use the built-in Binary Ninja MCP server; inspect tools/list for this installed version.`,
      );
    return tool;
  }

  /** Return discovered mappings for diagnostics and profile commitments. */
  inventory(): Record<string, string> {
    return Object.fromEntries(
      [...this.#tools].map(([role, tool]) => [role, tool.name]),
    );
  }

  /** Send only advertised arguments and preserve the original MCP response. */
  async call(
    role: BinaryNinjaToolRole,
    values: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    if (signal?.aborted === true) throw new AnalysisCancelledError(role);
    const tool = this.tool(role);
    const schema = z
      .object({
        properties: z.record(z.string(), z.unknown()).default({}),
        required: z.array(z.string()).default([]),
      })
      .parse(tool.inputSchema);
    const args = Object.fromEntries(
      Object.entries(values).filter(([key]) => key in schema.properties),
    );
    const missing = schema.required.filter((key) => !(key in args));
    if (missing.length > 0)
      throw new AnalysisCapabilityUnavailableError(
        "binary-ninja",
        role,
        `${tool.name} requires unsupported arguments: ${missing.join(", ")}`,
      );
    const result = await this.client.callTool(
      { name: tool.name, arguments: args },
      { ...this.options(signal), toolDefinition: tool },
    );
    this.raw.push(jsonValueSchema.parse(result));
    if (result.isError === true)
      throw new ProviderAdapterError("binary-ninja", role, {
        diagnostics: {
          reason: "remote_tool_error",
          tool: tool.name,
          response: redactValue(
            jsonValueSchema.parse(result),
            this.config.token,
          ),
        },
      });
    if (result.structuredContent !== undefined)
      return jsonValueSchema.parse(result.structuredContent);
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    try {
      return jsonValueSchema.parse(JSON.parse(text));
    } catch {
      return text;
    }
  }

  /** Drain a list using the server's reported nextOffset, rejecting incomplete pages. */
  async list(
    role: BinaryNinjaToolRole,
    values: Readonly<Record<string, JsonValue>> = {},
    signal?: AbortSignal,
  ): Promise<Record<string, JsonValue>[]> {
    const rows: Record<string, JsonValue>[] = [];
    let offset = 0;
    for (;;) {
      const value = await this.call(role, { ...values, offset }, signal);
      const page = records(value, role);
      rows.push(...page);
      const metadata = jsonObjectSchema.safeParse(value);
      if (!metadata.success || metadata.data.truncated !== true) return rows;
      const next = z
        .number()
        .int()
        .safe()
        .min(offset + 1)
        .safeParse(metadata.data.nextOffset);
      if (!next.success || page.length === 0)
        throw new AnalysisOutputError(
          role,
          "Binary Ninja returned a truncated page without a progressing nextOffset",
        );
      if (!("offset" in (this.tool(role).inputSchema.properties ?? {})))
        throw new AnalysisOutputError(
          role,
          "Binary Ninja truncated a tool without advertised pagination",
        );
      offset = next.data;
    }
  }

  /** Close the SDK transport, including any owned headless child process. */
  async close(): Promise<void> {
    await this.client.close();
  }

  private options(signal?: AbortSignal) {
    return {
      timeout: this.config.timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    };
  }
}

/** Parse object rows or a column/row table; never interpret text as successful empty data. */
export const records = (
  value: JsonValue,
  role: string,
): Record<string, JsonValue>[] => {
  if (Array.isArray(value))
    return value.map((row) => jsonObjectSchema.parse(row));
  const object = jsonObjectSchema.parse(value);
  for (const key of [
    role,
    "items",
    "results",
    "functions",
    "symbols",
    "strings",
    "segments",
    "binaryViews",
    "views",
    "callers",
    "callees",
    "references",
  ]) {
    if (Array.isArray(object[key])) return records(object[key], role);
  }
  if (Array.isArray(object.rows)) {
    const columns = z.array(z.string()).parse(object.columns);
    return object.rows.map((row) => {
      if (!Array.isArray(row)) return jsonObjectSchema.parse(row);
      if (row.length !== columns.length)
        throw new AnalysisOutputError(
          role,
          "Binary Ninja row width disagrees with its columns",
        );
      return Object.fromEntries(
        columns.map((column, index) => [column, row[index] ?? null]),
      );
    });
  }
  throw new AnalysisOutputError(
    role,
    "Binary Ninja did not return a recognized row collection",
  );
};

/** Redact transport credentials while retaining provider diagnostics and local evidence. */
export const redactValue = (
  value: JsonValue,
  token: string | undefined,
): JsonValue => {
  if (token === undefined) return value;
  if (typeof value === "string") return value.replaceAll(token, "[redacted]");
  if (Array.isArray(value))
    return value.map((entry) => redactValue(entry, token));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactValue(entry, token),
      ]),
    );
  return value;
};
