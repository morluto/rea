import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ensureGeneratedFile } from "./lib/generated-file.mjs";

const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_)
  if (argument !== "--check")
    throw new Error(`Unknown MCP schema report option: ${argument}`);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cachebuster = `?${String(Date.now())}`;
const { TOOL_CONTRACTS } = await import(
  `${pathToFileURL(join(root, "dist/contracts/toolContracts.js")).href}${cachebuster}`
);
const { toolRegistrationOptions } = await import(
  `${pathToFileURL(join(root, "dist/server/toolRegistrationOptions.js")).href}${cachebuster}`
);

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const tools = TOOL_CONTRACTS.map((contract) => {
  const registration = toolRegistrationOptions(contract);
  const inputSchema = registration.inputSchema["~standard"].jsonSchema.input();
  const outputSchema =
    registration.outputSchema["~standard"].jsonSchema.output();
  const wire = {
    name: contract.name,
    title: registration.title,
    description: registration.description,
    inputSchema,
    outputSchema,
    annotations: registration.annotations,
  };
  return {
    name: contract.name,
    bytes: bytes(wire),
    input_schema_bytes: bytes(inputSchema),
    output_schema_bytes: bytes(outputSchema),
    wire,
  };
}).sort((left, right) => left.name.localeCompare(right.name));

const maximumToolBytes = 64 * 1024;
const maximumListBytes = 512 * 1024;
const listBytes = bytes({ tools: tools.map(({ wire }) => wire) });
const oversized = tools.filter((tool) => tool.bytes > maximumToolBytes);
if (oversized.length > 0 || listBytes > maximumListBytes)
  throw new Error(
    `MCP schema budget exceeded: tools/list=${String(listBytes)}, oversized=${oversized.map(({ name, bytes: size }) => `${name}:${String(size)}`).join(",")}`,
  );

const report = {
  generated_from: "@modelcontextprotocol/server 2.0.0-beta.4 wire registration",
  tool_count: tools.length,
  tools_list_bytes: listBytes,
  budgets: {
    tools_list_bytes: maximumListBytes,
    per_tool_bytes: maximumToolBytes,
  },
  tools: tools.map(({ wire: _wire, ...tool }) => tool),
};

await ensureGeneratedFile({
  path: join(root, "docs/mcp-schema-report.json"),
  source: `${JSON.stringify(report, null, 2)}\n`,
  check: arguments_.has("--check"),
  generateCommand: "npm run docs:generate",
});
