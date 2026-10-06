import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { parseConfig } from "../config.js";
import { BinaryNinjaProvider } from "./BinaryNinjaProvider.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** Synthetic built-in-server conventions, not a real Binary Ninja engine fixture. */
export const binaryNinjaFixture = async (
  options: {
    readonly missingTool?: string;
    readonly brokenPagination?: boolean;
    readonly failActivation?: boolean;
    readonly failClose?: boolean;
    readonly tokenError?: string;
    readonly textOnly?: boolean;
    readonly analysisComplete?: boolean;
    readonly closeRefused?: boolean;
    readonly beforePseudocode?: () => void;
  } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "rea-test-bn-"));
  const path = join(root, "sample.elf");
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(62, 18);
  await writeFile(path, bytes);
  const target: BinaryTarget = {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    kind: "executable",
    format: "elf",
    architecture: "x86_64",
    availableArchitectures: ["x86_64"],
  };
  const parsed = parseConfig({
    REA_ANALYSIS_PROVIDER: "binary-ninja",
    REA_BINARY_NINJA_MCP_URL: "http://127.0.0.1:24642/mcp",
    REA_BINARY_NINJA_MCP_TOKEN: "test-auth-token",
    REA_BINARY_NINJA_MCP_TIMEOUT_MS: "1000",
  });
  if (!parsed.ok) throw parsed.error;
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const servers: McpServer[] = [];
  const pending: Promise<void>[] = [];
  const snapshots: string[] = [];
  const reply = (data: Record<string, JsonValue>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    ...(options.textOnly === true ? {} : { structuredContent: data }),
  });
  const makeServer = () => {
    const server = new McpServer({
      name: "binaryninja-fixture",
      version: "5.3-test",
    });
    servers.push(server);
    const register = (
      name: string,
      schema: z.ZodRawShape,
      handler: (
        args: Record<string, unknown>,
      ) => Promise<Record<string, JsonValue>> | Record<string, JsonValue>,
    ) => {
      if (options.missingTool === name) return;
      server.registerTool(
        name,
        { inputSchema: z.object(schema) },
        async (args) => {
          const input = z.record(z.string(), z.unknown()).parse(args);
          calls.push({ name, input });
          if (name === "bn_function_pseudo_c") options.beforePseudocode?.();
          if (
            name === "bn_function_pseudo_c" &&
            options.tokenError !== undefined
          )
            return { ...reply({ error: options.tokenError }), isError: true };
          return reply(await handler(input));
        },
      );
    };
    configureLifecycle(register, { options, snapshots, bytes });
    configureInspection(register, options);
    return server;
  };
  const factory = () => {
    const server = makeServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    pending.push(server.connect(serverTransport));
    return clientTransport;
  };
  const provider = new BinaryNinjaProvider(parsed.value, factory);
  const resolve = async () => {
    const result = await provider.resolveAnalysisProfile(target);
    if (!result.ok) throw result.error;
    if (result.value.profile === null)
      throw new Error("Missing fixture profile");
    return result.value.profile;
  };
  return {
    target,
    config: parsed.value,
    provider,
    makeServer,
    factory,
    calls,
    snapshots,
    resolve,
    close: async () => {
      await Promise.all(pending);
      await Promise.all(servers.map((server) => server.close()));
      await Promise.all(
        snapshots.map((snapshot) =>
          rm(join(snapshot, ".."), { recursive: true, force: true }),
        ),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
};

type Register = (
  name: string,
  schema: z.ZodRawShape,
  handler: (
    args: Record<string, unknown>,
  ) => Promise<Record<string, JsonValue>> | Record<string, JsonValue>,
) => void;
type FixtureOptions = NonNullable<Parameters<typeof binaryNinjaFixture>[0]>;
const functions = [
  { start: "0x401000", name: "main", arch: "x86_64" },
  { start: "0xfffffffffffffff0", name: "helper", arch: "x86_64" },
];
const pagination = {
  offset: z.number().int().default(0),
  limit: z.number().int().optional(),
};
const func = {
  function: z.string(),
  arch: z.string().optional(),
  ...pagination,
};

const configureLifecycle = (
  register: Register,
  context: { options: FixtureOptions; snapshots: string[]; bytes: Buffer },
) => {
  const { options, snapshots, bytes } = context;
  register("bn_file_open", { path: z.string() }, async (args) => {
    const snapshot = z.string().parse(args.path);
    snapshots.push(snapshot);
    if (!(await readFile(snapshot)).equals(bytes))
      throw new Error("Opened bytes differ from the fixture");
    return { openItem: "owned-item" };
  });
  register("bn_open_item_close", { openItem: z.string() }, () => {
    if (options.failClose === true) throw new Error("close refused");
    return { closed: options.closeRefused !== true };
  });
  register(
    "bn_binary_view_list",
    { openItem: z.string(), ...pagination },
    () => ({
      binaryViews: [
        { binaryView: "owned-view", type: "ELF", recommended: true },
        { binaryView: "raw-view", type: "Raw", recommended: false },
      ],
      truncated: false,
    }),
  );
  register("bn_binary_view_set_active", { binaryView: z.string() }, () => {
    if (options.failActivation === true) throw new Error("activation failed");
    return { active: true };
  });
  register("bn_analysis_update_and_wait", {}, () => ({
    complete: options.analysisComplete !== false,
  }));
};
const configureInspection = (register: Register, options: FixtureOptions) => {
  register("bn_function_list", pagination, (args) => {
    const offset = z.number().parse(args.offset);
    const row = functions[offset];
    return {
      columns: ["start", "name", "arch"],
      rows: row === undefined ? [] : [[row.start, row.name, row.arch]],
      count: row === undefined ? 0 : 1,
      total: 2,
      truncated: offset === 0,
      nextOffset: options.brokenPagination === true ? 0 : offset + 1,
    };
  });
  register("bn_symbol_list", pagination, () => ({
    symbols: [{ address: "0x401000", name: "main" }],
    truncated: false,
  }));
  register("bn_string_list", pagination, () => ({
    strings: [{ address: "0x402000", value: "Hello World" }],
    truncated: false,
  }));
  register("bn_segment_list", pagination, () => ({
    segments: [
      {
        start: "0x401000",
        end: "0x402000",
        readable: true,
        writable: false,
        executable: true,
      },
    ],
    truncated: false,
  }));
  register("bn_function_get", func, () => ({
    signature: "int main(void)",
    basicblock_count: 1,
    length: 2,
  }));
  register("bn_function_pseudo_c", func, () => ({
    text: "int main() { return 0; }",
  }));
  register("bn_function_disassembly", func, () => ({
    lines: [
      { address: "0x401000", text: "xor eax, eax" },
      { address: "0x401002", text: "ret" },
    ],
  }));
  register("bn_function_callers", func, () => ({
    callers: [],
    truncated: false,
  }));
  register("bn_function_callees", func, () => ({
    callees: [functions[1] ?? {}],
    truncated: false,
  }));
  register(
    "bn_memory_read",
    { address: z.string(), length: z.number() },
    () => ({ address: "0x401000", hex: "31c0", length: 2 }),
  );
  register("bn_address_xrefs", { address: z.string(), ...pagination }, () => ({
    references: [{ source: "0x401002" }],
    truncated: false,
  }));
};
