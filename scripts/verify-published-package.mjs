import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? ""))
  throw new Error("Usage: node scripts/verify-published-package.mjs <version>");

const serverEnvironment = { ...process.env };
delete serverEnvironment.HOPPER_TARGET_PATH;
const transport = new StdioClientTransport({
  command: "npx",
  args: ["--yes", "--package", `rea-agents@${version}`, "rea", "mcp"],
  env: serverEnvironment,
  stderr: "pipe",
});
const client = new Client({ name: "published-package-canary", version: "1" });
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  if (stderr.length < 16_384) stderr += chunk.toString("utf8");
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 70)
    throw new Error(
      `Published MCP exposed ${String(tools.tools.length)} tools`,
    );
  const status = await client.callTool({
    name: "binary_session",
    arguments: {},
  });
  if (status.isError === true)
    throw new Error("Published target-free MCP session check failed");
} catch (cause) {
  throw new Error(`Published MCP canary failed: ${stderr}`, { cause });
} finally {
  await client.close();
  await transport.close();
}

process.stdout.write(
  `${JSON.stringify({ package: "rea-agents", version, mcpTools: 70 })}\n`,
);
