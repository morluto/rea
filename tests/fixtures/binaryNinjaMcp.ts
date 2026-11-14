import { createTestTempDirectory } from "./temporaryDirectory.js";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BinaryTarget } from "../../src/domain/binaryTargetTypes.js";
import type { JsonValue } from "../../src/domain/jsonValue.js";
import {
  BinaryNinjaToolError,
  type BinaryNinjaMcpConnection,
  type BinaryNinjaToolReply,
} from "../../src/binaryNinja/BinaryNinjaMcpConnection.js";
import {
  BINARY_NINJA_COLUMNS,
  type BinaryNinjaTableTool,
} from "../../src/binaryNinja/BinaryNinjaProtocolValues.js";
import { BINARY_NINJA_REQUIRED_TOOLS } from "../../src/binaryNinja/BinaryNinjaSessionClient.js";
import { elf } from "../../src/domain/binaryTarget.fixture.js";

/** Create a test-owned executable without invoking an engine. */
export const createBinaryNinjaTarget = async () => {
  const root = await createTestTempDirectory("rea-binary-ninja-test-");
  const path = join(root, "target.elf");
  const bytes = elf(2, 1, 62);
  await writeFile(path, bytes);
  const target: BinaryTarget = {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    kind: "executable",
    format: "elf",
    architecture: "x86_64",
    availableArchitectures: ["x86_64"],
  };
  return { target, bytes };
};

interface FixtureFunction {
  readonly address: string;
  readonly name: string;
  readonly pseudocode: readonly string[];
  readonly disassembly: readonly string[];
  readonly callers: readonly (readonly [string, string])[];
  readonly callees: readonly (readonly [string, string])[];
}

interface FixtureString {
  readonly address: string;
  readonly type: string;
  readonly bytes: Buffer;
}

const cell = (value: string): string => value.replaceAll("|", "\\|");

/** Render a reply exactly as Binary Ninja 6.0's GUI MCP server formats tables. */
export const renderBinaryNinjaTable = (
  tool: BinaryNinjaTableTool,
  metadata: Readonly<Record<string, JsonValue>>,
  rows: readonly (readonly string[])[],
): string => {
  const columns = BINARY_NINJA_COLUMNS[tool];
  return [
    "---",
    `tool: ${JSON.stringify(tool)}`,
    ...Object.entries(metadata).map(
      ([key, value]) => `${key}: ${JSON.stringify(value)}`,
    ),
    "---",
    "",
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
    "",
  ].join("\n");
};

const page = (
  offset: number,
  limit: number,
  total: number,
): Record<string, JsonValue> => {
  const count = Math.max(0, Math.min(limit, total - offset));
  const next = offset + count < total ? offset + count : null;
  return {
    offset,
    limit,
    count,
    total,
    nextOffset: next,
    truncated: next !== null,
  };
};

/** Stateful producer fixture at the real connection seam; no module mocking. */
export class RecordingBinaryNinjaMcp implements BinaryNinjaMcpConnection {
  readonly calls: {
    name: string;
    args: Readonly<Record<string, JsonValue>>;
  }[] = [];
  tools: string[] = [...BINARY_NINJA_REQUIRED_TOOLS];
  connects = 0;
  closes = 0;
  /** Largest page the fixture serves, to exercise pagination. */
  pageSize = 1000;
  analysisState = "IdleState";
  active: string | null = null;
  openPath: string;
  rawBytes: Buffer;
  /** Called before each reply; may change producer state mid-request. */
  beforeCall?: (name: string) => void;
  readonly views = [
    {
      handle: "view_1",
      viewType: "ELF",
      recommended: true,
      architecture: "x86_64",
      platform: "linux-x86_64",
      start: "0x400000",
      end: "0x403000",
      entryPoint: "0x401000",
    },
    {
      handle: "view_2",
      viewType: "Raw",
      recommended: false,
      architecture: "",
      platform: "",
      start: "0x0",
      end: "0x0",
      entryPoint: "0x0",
    },
  ];
  functions: FixtureFunction[] = [
    {
      address: "0x401000",
      name: "main",
      pseudocode: ["  int32_t main()", "", "{", "    return helper(1);", "}"],
      disassembly: [
        "  int32_t main()",
        "",
        "0x401000  push    rbp",
        "0x401001  call    helper",
        "0x401006  ret     ",
      ],
      callers: [],
      callees: [["0x401001", "helper, with (parens) (0x401100 (x86_64))"]],
    },
    {
      address: "0x401100",
      name: "helper, with (parens)",
      pseudocode: [
        "  int32_t helper()",
        "",
        "{",
        '    return puts("a|b");',
        "}",
      ],
      disassembly: [
        "  int32_t helper()",
        "",
        "0x401100  lea     rdi, [rel 0x402000]",
        "0x401107  jmp     qword [rel 0x403000]",
      ],
      callers: [["0x401001", "main (0x401000 (x86_64))"]],
      callees: [["0x401107", ""]],
    },
  ];
  symbols = new Map<string, string>([["0x403000", "puts"]]);
  dataXrefs = new Map<string, string[]>([["0x401100", ["0x402100"]]]);
  strings: FixtureString[] = [
    { address: "0x402000", type: "AsciiString", bytes: Buffer.from("a|b") },
    {
      address: "0x402010",
      type: "Utf16String",
      bytes: Buffer.from("wide", "utf16le"),
    },
    {
      address: "0x402200",
      type: "AsciiString",
      bytes: Buffer.from("L".repeat(300)),
    },
  ];

  constructor(target: BinaryTarget, bytes: Buffer) {
    this.openPath = target.path.replaceAll("\\", "/");
    this.rawBytes = bytes;
    const raw = this.views[1];
    if (raw !== undefined)
      Object.assign(raw, { end: `0x${bytes.length.toString(16)}` });
  }

  async connect() {
    this.connects++;
    return [...this.tools];
  }

  serverInfo(): JsonValue {
    return { name: "binaryninja_ui_mcp", version: "0.1.0" };
  }

  async close() {
    this.closes++;
  }

  #view(handle: string | null) {
    const view = this.views.find((entry) => entry.handle === handle);
    return view === undefined
      ? null
      : {
          ...view,
          openItem: "item_1",
          longName: view.viewType,
          created: true,
          active: view.handle === this.active,
          available: true,
          addressSize: 8,
          modified: false,
          analysisModified: false,
        };
  }

  #text(text: string): BinaryNinjaToolReply {
    return { text, structured: null };
  }

  #structured(value: Record<string, JsonValue>): BinaryNinjaToolReply {
    return { text: JSON.stringify(value), structured: value };
  }

  #function(name: string, args: Readonly<Record<string, JsonValue>>) {
    const fn = this.functions.find((entry) => entry.address === args.function);
    if (fn === undefined)
      throw new BinaryNinjaToolError(
        name,
        "function_not_found",
        "No matching function was found",
      );
    return fn;
  }

  #requireActive(name: string): void {
    if (this.active === null)
      throw new BinaryNinjaToolError(
        name,
        "no_active_binary_view",
        "No active Binary Ninja binary view is selected",
      );
  }

  #rows<T>(
    tool: string,
    args: Readonly<Record<string, JsonValue>>,
    items: readonly T[],
    row: (item: T) => readonly string[],
    metadata: Readonly<Record<string, JsonValue>> = {},
  ): BinaryNinjaToolReply {
    const offset = Number(args.offset ?? 0);
    const limit = Math.min(Number(args.limit ?? 100), this.pageSize);
    return this.#text(
      renderBinaryNinjaTable(
        tool as BinaryNinjaTableTool,
        { ...metadata, ...page(offset, limit, items.length) },
        items.slice(offset, offset + limit).map(row),
      ),
    );
  }

  #code(
    tool: string,
    args: Readonly<Record<string, JsonValue>>,
  ): BinaryNinjaToolReply {
    const fn = this.#function(tool, args);
    const lines =
      tool === "bn_function_decompile" ? fn.pseudocode : fn.disassembly;
    const offset = Number(args.offset ?? 0);
    const limit = Math.min(Number(args.limit ?? 1000), this.pageSize);
    const metadata = {
      function: fn.address,
      arch: "x86_64",
      name: fn.name,
      platform: "linux-x86_64",
      ...page(offset, limit, lines.length),
    };
    return this.#text(
      [
        "---",
        `tool: ${JSON.stringify(tool)}`,
        ...Object.entries(metadata).map(
          ([key, value]) => `${key}: ${JSON.stringify(value)}`,
        ),
        "---",
        "",
        tool === "bn_function_decompile" ? "````bn-pseudoc" : "````asm",
        ...lines.slice(offset, offset + limit),
        "````",
        "",
      ].join("\n"),
    );
  }

  readonly #handlers: Readonly<
    Record<
      string,
      (
        name: string,
        args: Readonly<Record<string, JsonValue>>,
      ) => BinaryNinjaToolReply
    >
  > = {
    bn_open_item_list: (
      name: string,
      args: Readonly<Record<string, JsonValue>>,
    ): BinaryNinjaToolReply => {
      return this.#rows(name, args, [this.openPath], (path) => [
        "item_1",
        "file",
        "target.elf",
        path,
        "",
        "1",
        "false",
        "false",
        "true",
        "false",
        "true",
      ]);
    },
    bn_binary_view_list: (
      name: string,
      args: Readonly<Record<string, JsonValue>>,
    ): BinaryNinjaToolReply => {
      return this.#rows(name, args, this.views, (view) => [
        view.handle,
        "item_1",
        view.viewType,
        view.viewType,
        "true",
        String(view.handle === this.active),
        "true",
        String(view.recommended),
        view.architecture,
        view.platform,
        "8",
        view.start,
        view.end,
        view.entryPoint,
        "false",
        "false",
      ]);
    },
    bn_binary_view_get_active: (): BinaryNinjaToolReply => {
      return this.#structured({
        binaryView: this.#view(this.active),
        warnings: [],
      });
    },
    bn_binary_view_set_active: (
      name: string,
      args: Readonly<Record<string, JsonValue>>,
    ): BinaryNinjaToolReply => {
      const handle = String(args.binaryView);
      if (this.#view(handle) === null)
        throw new BinaryNinjaToolError(name, "invalid_params", "Unknown view");
      const changed = this.active !== handle;
      this.active = handle;
      return this.#structured({ binaryView: this.#view(handle), changed });
    },
    bn_analysis_status: (): BinaryNinjaToolReply => {
      return this.#structured({
        analysis: { state: this.analysisState, stateValue: 2 },
        warnings: [],
      });
    },
    bn_memory_read: (
      name: string,
      args: Readonly<Record<string, JsonValue>>,
    ): BinaryNinjaToolReply => {
      this.#requireActive(name);
      const start = Number(BigInt(String(args.address)));
      const length = Number(args.length);
      let bytes: Buffer;
      if (this.active === "view_2")
        bytes = this.rawBytes.subarray(start, start + length);
      else {
        const value = this.strings.find(
          (entry) =>
            BigInt(String(args.address)) >= BigInt(entry.address) &&
            BigInt(String(args.address)) <
              BigInt(entry.address) + BigInt(entry.bytes.length),
        );
        const offset =
          value === undefined
            ? 0
            : Number(BigInt(String(args.address)) - BigInt(value.address));
        bytes = (value?.bytes ?? Buffer.alloc(0)).subarray(
          offset,
          offset + length,
        );
      }
      return this.#structured({
        address: String(args.address),
        requestedLength: `0x${length.toString(16)}`,
        bytesRead: bytes.length,
        hex: bytes.toString("hex"),
        warnings: [],
      });
    },
    bn_function_list: (
      name: string,
      args: Readonly<Record<string, JsonValue>>,
    ): BinaryNinjaToolReply => {
      this.#requireActive(name);
      const query =
        typeof args.query === "string" ? args.query.toLowerCase() : "";
      return this.#rows(
        name,
        args,
        this.functions.filter((fn) => fn.name.toLowerCase().includes(query)),
        (fn) => [
          fn.address,
          "x86_64",
          fn.name,
          "linux-x86_64",
          fn.address,
          fn.address,
          "int32_t()",
          "1",
          "false",
          "false",
        ],
        name === "bn_function_search" ? { query: String(args.query) } : {},
      );
    },
    bn_function_search: (name, args) =>
      this.#handlers.bn_function_list!(name, args),
    bn_function_info: (
      name: string,
      args: Readonly<Record<string, JsonValue>>,
    ): BinaryNinjaToolReply => {
      this.#requireActive(name);
      const fn = this.#function(name, args);
      return this.#text(
        [
          "---",
          `tool: "bn_function_info"`,
          `function: ${JSON.stringify(fn.address)}`,
          `arch: "x86_64"`,
          `name: ${JSON.stringify(fn.name)}`,
          `platform: "linux-x86_64"`,
          "---",
          "",
          "## Function",
          "",
        ].join("\n"),
      );
    },
    bn_function_decompile: (
      name: string,
      args: Readonly<Record<string, JsonValue>>,
    ): BinaryNinjaToolReply => {
      this.#requireActive(name);
      return this.#code(name, args);
    },
    bn_function_disassembly: (name, args) =>
      this.#handlers.bn_function_decompile!(name, args),
    bn_function_callers: (
      name: string,
      args: Readonly<Record<string, JsonValue>>,
    ): BinaryNinjaToolReply => {
      this.#requireActive(name);
      const fn = this.#function(name, args);
      const metadata = {
        function: fn.address,
        arch: "x86_64",
        name: fn.name,
        platform: "linux-x86_64",
      };
      return name === "bn_function_callers"
        ? this.#rows(
            name,
            args,
            fn.callers,
            ([site, caller]) => [site, "x86_64", caller],
            metadata,
          )
        : this.#rows(
            name,
            args,
            fn.callees,
            ([site, callee]) => [
              site,
              "x86_64",
              /\((0x[0-9a-f]+) \(/u.exec(callee)?.[1] ?? "0x403000",
              callee,
            ],
            metadata,
          );
    },
    bn_function_callees: (name, args) =>
      this.#handlers.bn_function_callers!(name, args),
    bn_string_list: (
      name: string,
      args: Readonly<Record<string, JsonValue>>,
    ): BinaryNinjaToolReply => {
      this.#requireActive(name);
      return this.#rows(
        name,
        args,
        this.strings,
        (entry) => {
          const preview = entry.bytes.subarray(0, Number(args.previewBytes));
          return [
            entry.address,
            entry.type,
            `0x${entry.bytes.length.toString(16)}`,
            preview.toString("latin1"),
            preview.toString("hex"),
            String(preview.length < entry.bytes.length),
          ];
        },
        { previewBytes: Number(args.previewBytes) },
      );
    },
    bn_symbol_list_at: (
      name: string,
      args: Readonly<Record<string, JsonValue>>,
    ): BinaryNinjaToolReply => {
      this.#requireActive(name);
      const symbol = this.symbols.get(String(args.address));
      return this.#text(
        renderBinaryNinjaTable(
          name as BinaryNinjaTableTool,
          {
            address: String(args.address),
            count: symbol === undefined ? 0 : 1,
          },
          symbol === undefined
            ? []
            : [
                [
                  String(args.address),
                  symbol,
                  "ImportAddressSymbol",
                  "BNINTERNALNAMESPACE",
                  "0",
                  "NoBinding",
                  symbol,
                  "true",
                ],
              ],
        ),
      );
    },
    bn_data_xrefs_to: (
      name: string,
      args: Readonly<Record<string, JsonValue>>,
    ): BinaryNinjaToolReply => {
      this.#requireActive(name);
      return this.#rows(
        name,
        args,
        this.dataXrefs.get(String(args.address)) ?? [],
        (source) => [source, source, "void*"],
        { address: String(args.address) },
      );
    },
  };

  async call(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
  ): Promise<BinaryNinjaToolReply> {
    this.calls.push({ name, args });
    this.beforeCall?.(name);
    const handler = this.#handlers[name];
    if (handler === undefined || !this.tools.includes(name))
      throw new BinaryNinjaToolError(name, "unknown_tool", "Unknown tool");
    return handler(name, args);
  }
}
