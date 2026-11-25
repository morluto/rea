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
  Buffer.byteLength(DECOMPILE_BODY) + "\n" + DECOMPILE_BODY;
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
      reply(id, { tools: [] });
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
        jsonReply(id, cannedLoad());
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
