// Synthetic built-in MCP conventions for process-boundary tests; no Binary Ninja engine.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({
  name: "binaryninja-stdio-fixture",
  version: "5.3-test",
});
const reply = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
const tools = [
  ["bn_file_open", { path: z.string() }, { openItem: "stdio-owned" }],
  ["bn_open_item_close", { openItem: z.string() }, { closed: true }],
  [
    "bn_binary_view_list",
    { openItem: z.string() },
    {
      binaryViews: [
        { binaryView: "stdio-view", recommended: true, type: "ELF" },
      ],
    },
  ],
  ["bn_binary_view_set_active", { binaryView: z.string() }, { active: true }],
  ["bn_analysis_update_and_wait", {}, { complete: true }],
  [
    "bn_function_list",
    { offset: z.number().default(0) },
    {
      functions: [{ start: "0x401000", name: "main", arch: "x86_64" }],
      truncated: false,
    },
  ],
  [
    "bn_segment_list",
    {},
    { segments: [{ start: "0x401000", end: "0x402000" }], truncated: false },
  ],
  [
    "bn_string_list",
    {},
    { strings: [{ address: "0x402000", value: "hello" }], truncated: false },
  ],
  [
    "bn_function_pseudo_c",
    { function: z.string(), arch: z.string().optional() },
    { text: "int main() { return 0; }" },
  ],
  [
    "bn_function_disassembly",
    { function: z.string(), arch: z.string().optional() },
    { text: "0x401000 ret" },
  ],
  [
    "bn_function_callers",
    { function: z.string(), arch: z.string().optional() },
    { callers: [], truncated: false },
  ],
  [
    "bn_function_callees",
    { function: z.string(), arch: z.string().optional() },
    { callees: [], truncated: false },
  ],
];
for (const [name, shape, response] of tools)
  server.registerTool(name, { inputSchema: z.object(shape) }, () =>
    reply(response),
  );
await server.connect(new StdioServerTransport());
