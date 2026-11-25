import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Scripted fake of the xpanda MCP stdio server. Reply shapes follow real
 * xpanda 2.1.0 responses captured against its md5.abc sample; unmodeled
 * commands are refused so producer-contract drift fails loudly. The fake
 * reads its behavior from `<behavior>.json` and appends one line per request
 * to `<calls>.jsonl`. REA launches the engine with no inherited PATH beyond
 * its own host environment, so the script is plain JavaScript executed by
 * the test's Node binary directly.
 */
const SCRIPT = String.raw`
const fs = require("node:fs");
const behaviorPath = process.env.REA_TEST_XPANDA_BEHAVIOR;
const callsPath = process.env.REA_TEST_XPANDA_CALLS;
const behavior = JSON.parse(fs.readFileSync(behaviorPath, "utf8"));
const log = (entry) =>
  fs.appendFileSync(callsPath, JSON.stringify({ pid: process.pid, at: Date.now(), ...entry }) + "\n");
const hang = () => setInterval(() => {}, 60_000);
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const replyError = (id, message) =>
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: "ERROR: Error: " + message }], isError: true },
    }) + "\n",
  );
const textReply = (id, text) =>
  reply(id, { content: [{ type: "text", text }] });
const jsonReply = (id, value) => textReply(id, JSON.stringify(value, null, 2));

const TOOL_NAMES = [
  "abc_load",
  "abc_close",
  "abc_list_classes",
  "abc_get_class",
  "abc_decompile_class",
  "abc_decompile_method",
  "abc_export",
  "abc_disassemble_method",
  "abc_search_strings",
  "abc_search_symbols",
  "abc_search_code",
  "abc_xrefs",
  "abc_call_graph",
  "hap_read_abc",
  "hap_resources",
];
const cannedLoad = () => ({
  fileId: "md5-5411df7",
  path: "/rea-fake/staged/input.abc",
  cached: false,
  bytecodeVersion: "11.0.2.0",
  checksum: "0x5411df7",
  fileSizeBytes: 8016,
  classCount: 2,
  foreignClassCount: 1,
  lnpCount: 10,
  classesPreview: ["_ESSlotNumberAnnotation", "_GLOBAL"],
  previewTruncated: false,
  hint: "使用 abc_list_classes 分页浏览全部类;abc_decompile_class 反编译单个类。",
  ...(behavior.loadFacts ?? {}),
});
const cannedHapLoad = () => ({
  kind: "hap",
  fileId: "hap-md5",
  path: "/rea-fake/staged/input.abc",
  cached: false,
  bundleName: "com.example.app",
  moduleName: "entry",
  versionName: "1.0.0",
  virtualMachine: "ark",
  fileSizeBytes: 8016,
  abcEntries: [{ name: "ets/modules.abc", size: 7000 }],
  resourceItemCount: 3,
  hint: "hap_read_abc 把 .abc 条目解出为 abc 会话(返回 abcFileId);hap_resources 查询资源表。",
});
const cannedList = (fileId) => ({
  fileId,
  total: 2,
  filtered: 2,
  offset: 0,
  returned: 2,
  truncated: false,
  classes: [
    { name: "_ESSlotNumberAnnotation", methods: 0, fields: 0, external: false },
    { name: "_GLOBAL", methods: 14, fields: 0, external: false },
  ],
});
const DECOMPILE_BODY = "/*\n* class name:L_GLOBAL;\n*/\n(function () {})();\n";
const cannedDecompile = (className) =>
  "// xpanda-mcp class=" + className + " simplified=true degraded=false chars=" +
  Buffer.byteLength(DECOMPILE_BODY) + " lines=4 cached=false offset=0 returned=4 truncated=false\n" +
  DECOMPILE_BODY;
const cannedMethodDecompile = (className, methodName) =>
  "// xpanda-mcp class=" + className + " method=" + methodName +
  " simplified=true degraded=false chars=" + Buffer.byteLength(DECOMPILE_BODY) +
  " lines=4 cached=false offset=0 returned=4 truncated=false\n" + DECOMPILE_BODY;
const cannedClassMetadata = (fileId, className) => ({
  fileId,
  name: className,
  rawName: "L" + className + ";",
  superClass: "java.lang.Object",
  external: false,
  accessFlags: "0x1",
  fields: [{ name: "slot", type: "i32", external: false }],
  methods: [
    {
      name: "func_main_0",
      accessFlags: "0x9",
      external: false,
      hasCode: true,
      hasTryCatch: false,
      shorty: "v ()",
    },
  ],
  imports: [],
  exports: [],
});
const cannedSymbols = (fileId) => ({
  fileId,
  total: 1,
  offset: 0,
  limit: 50,
  returned: 1,
  truncated: false,
  matches: [
    {
      kind: "method",
      rawName: "func_main_0",
      name: "func_main_0",
      ownerClass: "L_GLOBAL;",
      ownerClassName: "_GLOBAL",
      hasCode: true,
      external: false,
    },
  ],
});
const cannedCodeSearch = (fileId) => ({
  fileId,
  pattern: "md5",
  simplified: true,
  scannedClasses: 1,
  skippedClasses: 0,
  failedClasses: [],
  failedClassCount: 0,
  candidateClasses: 1,
  truncatedClasses: false,
  total: 1,
  offset: 0,
  limit: 50,
  returned: 1,
  truncated: false,
  matches: [
    { className: "_GLOBAL", line: 2, text: "  md5();", method: "func_main_0", methodKind: "function" },
  ],
  hint: "可用 abc_decompile_class 的 offset/limit 查看命中行附近上下文。",
});
const cannedXrefs = (fileId) => ({
  fileId,
  targetType: "class",
  target: "_GLOBAL",
  targetOwner: null,
  total: 1,
  offset: 0,
  limit: 50,
  returned: 1,
  truncated: false,
  sourceScannedClasses: 0,
  sourceTruncatedClasses: false,
  xrefCount: 1,
  disassemblyFailures: 0,
  matches: [
    {
      fromClass: "_GLOBAL",
      fromClassRaw: "L_GLOBAL;",
      fromMethod: "func_main_0",
      pc: 8,
      opcode: "lda",
      kind: "call",
      targetType: "class",
      targetName: "_GLOBAL",
      targetClass: null,
      targetClassRaw: null,
      origin: "bytecode",
    },
  ],
  hint: "static 字节码的方法/字段/类引用来自精确指令操作数。",
});
const cannedCallGraph = (fileId, className, methodName) => ({
  fileId,
  root: { class: className, classRaw: "L" + className + ";", method: methodName },
  direction: "both",
  depth: 2,
  nodeCount: 2,
  edgeCount: 1,
  truncated: false,
  disassemblyFailures: 0,
  sourceTruncatedClasses: false,
  nodes: [
    { id: className + "#" + methodName, classRaw: "L" + className + ";", className: className, method: methodName, depth: 0, via: ["root"] },
    { id: className + "#caller", classRaw: "L" + className + ";", className: className, method: "caller", depth: 1, via: ["callers"] },
  ],
  edges: [{ from: className + "#caller", to: className + "#" + methodName, kind: "call" }],
});
const cannedHapAbc = () => ({
  abcFileId: "hap-md5-entry",
  entry: "ets/modules.abc",
  cached: false,
  runtime: "dynamic",
  bytecodeVersion: "11.0.2.0",
  classCount: 2,
  classesPreview: ["_ESSlotNumberAnnotation", "_GLOBAL"],
  previewTruncated: false,
  hint: "abcFileId 可用于 abc_list_classes / abc_decompile_class / abc_search_strings 等全部 abc_* 工具。",
});
const cannedHapResources = (fileId) => ({
  fileId,
  format: "RestoolV2",
  version: 1,
  total: 3,
  matched: 1,
  byType: { string: 1 },
  byLimitKey: { base: 1 },
  offset: 0,
  limit: 50,
  items: [{ id: "0x03000003", name: "app_name", type: "string", limitKey: "base", value: "REA" }],
  truncated: false,
});
const cannedDisassembly =
  "method: func_main_0  vregs=0 args=3  blocks=1\n\nentry:\n\t0:definefunc || acc = 0, method:\"#1#\", 0\n\t8:returnundefined || ";
const cannedStrings = (fileId) => ({
  fileId,
  poolSize: 31,
  matched: 5,
  offset: 0,
  returned: 5,
  truncated: false,
  strings: [
    { offset: "0x1fd", content: "md5" },
    { offset: "0x202", content: "md5 of admin is " },
  ],
});
const cannedExport = (fileId, outDir) => {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(require("node:path").join(outDir, "_GLOBAL.js"), DECOMPILE_BODY);
  return {
    fileId,
    outDir,
    written: 1,
    skipped: 1,
    failed: 0,
    degradedClasses: [],
    files: ["_GLOBAL"],
    filesTruncated: false,
  };
};

let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline === -1) return;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (request.id === undefined) continue; // notification
    const { id, method, params } = request;
    log({ method, ...(params?.name === undefined ? {} : { tool: params.name }) });
    if (method === "initialize") {
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "xpanda", version: "1.0.0" },
      });
    } else if (method === "tools/list") {
      reply(id, {
        tools: TOOL_NAMES.map((name) => ({
          name,
          inputSchema: { type: "object", properties: {} },
        })),
      });
    } else if (method === "ping") {
      reply(id, {});
    } else if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "abc_load") {
        if (behavior.load === "hang") return hang();
        if (behavior.load === "badmagic") {
          replyError(id, "PandaParseException: invalid magic PANDA\\0\\0\\0 missing; the file may not be Ark bytecode");
          return;
        }
        jsonReply(id, behavior.hap === true ? cannedHapLoad() : cannedLoad());
      } else if (name === "abc_close") {
        jsonReply(id, { fileId: args.fileId, closed: true });
      } else if (name === "abc_list_classes") {
        if (behavior.abc_list_classes === "hang") return hang();
        if (behavior.abc_list_classes === "error")
          return replyError(id, "list failed");
        if (behavior.abc_list_classes === "not-json")
          return textReply(id, "not json at all");
        jsonReply(id, cannedList(args.fileId));
      } else if (name === "abc_decompile_class") {
        if (behavior.abc_decompile_class === "hang") return hang();
        if (behavior.abc_decompile_class === "empty")
          return textReply(id, "// 反编译结果为空(该类可能没有 func_main_0 入口或反编译失败)");
        if (behavior.abc_decompile_class === "error")
          return replyError(id, "类未找到: NoSuchClass\n候选: \n - _GLOBAL\n可先用 abc_list_classes 查看类列表");
        textReply(id, cannedDecompile(args.className ?? "_GLOBAL"));
      } else if (name === "abc_disassemble_method") {
        if (behavior.abc_disassemble_method === "hang") return hang();
        if (behavior.abc_disassemble_method === "error")
          return replyError(
            id,
            "反汇编失败: PandaInstruction not implemented: jeq\n该方法包含未实现的指令(通常是 jeq/jne/jstricteq/jnstricteq 家族),反编译器对该方法同样会降级为线性输出。",
          );
        textReply(id, cannedDisassembly);
      } else if (name === "abc_export") {
        if (behavior.abc_export === "hang") return hang();
        if (behavior.abc_export === "error") return replyError(id, "export failed");
        jsonReply(id, cannedExport(args.fileId, args.outDir));
      } else if (name === "abc_get_class") {
        jsonReply(
          id,
          cannedClassMetadata(args.fileId, args.className ?? "_GLOBAL"),
        );
      } else if (name === "abc_decompile_method") {
        textReply(
          id,
          cannedMethodDecompile(
            args.className ?? "_GLOBAL",
            args.methodName ?? "func_main_0",
          ),
        );
      } else if (name === "abc_search_symbols") {
        jsonReply(id, cannedSymbols(args.fileId));
      } else if (name === "abc_search_code") {
        jsonReply(id, cannedCodeSearch(args.fileId));
      } else if (name === "abc_xrefs") {
        jsonReply(id, cannedXrefs(args.fileId));
      } else if (name === "abc_call_graph") {
        jsonReply(
          id,
          cannedCallGraph(
            args.fileId,
            args.className ?? "_GLOBAL",
            args.methodName ?? "func_main_0",
          ),
        );
      } else if (name === "hap_read_abc") {
        jsonReply(id, cannedHapAbc());
      } else if (name === "hap_resources") {
        jsonReply(id, cannedHapResources(args.fileId));
      } else if (name === "abc_search_strings") {
        if (behavior.abc_search_strings === "hang") return hang();
        if (behavior.abc_search_strings === "error")
          return replyError(id, "strings failed");
        jsonReply(id, cannedStrings(args.fileId));
      } else {
        replyError(id, "unmodeled fixture command: " + String(name));
      }
    } else {
      replyError(id, "unmodeled fixture method: " + String(method));
    }
  }
});
process.on("disconnect", () => process.exit(0));
`;

export interface FakeXpandaBehavior {
  readonly hap?: boolean;
  readonly load?: "ok" | "badmagic" | "hang";
  readonly loadFacts?: Record<string, unknown>;
  readonly abc_list_classes?: "ok" | "error" | "hang" | "not-json";
  readonly abc_decompile_class?: "ok" | "error" | "hang" | "empty";
  readonly abc_disassemble_method?: "ok" | "error" | "hang";
  readonly abc_export?: "ok" | "error" | "hang";
  readonly abc_search_strings?: "ok" | "error" | "hang";
}

/** Write the fake engine script and return its path. */
export const writeFakeXpandaServer = async (
  directory: string,
): Promise<string> => {
  const path = join(directory, "server.cjs");
  await writeFile(path, SCRIPT, { mode: 0o755 });
  return path;
};
