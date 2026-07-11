import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { TOOL_CONTRACTS } from "../dist/contracts/toolContracts.js";

const execFileAsync = promisify(execFile);
const timeout = 180_000;
const sessionsBefore = new Set(
  (await readdir("/tmp")).filter((name) => name.startsWith("bbm-")),
);

const textValue = (result) => {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Tool result omitted text");
  return text;
};

const jsonValue = (result) => JSON.parse(textValue(result));

if (!process.env.HOPPER_TARGET_PATH) {
  throw new Error("HOPPER_TARGET_PATH is required");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/main.js"],
  cwd: process.cwd(),
  env: process.env,
  stderr: "pipe",
});
let stderrBytes = 0;
transport.stderr?.on("data", (chunk) => {
  stderrBytes += chunk.length;
});
const client = new Client({ name: "real-hopper-verifier", version: "1.0.0" });
let summary;

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const expectedNames = TOOL_CONTRACTS.map(({ name }) => name).sort();
  const actualNames = listed.tools.map(({ name }) => name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("The real server did not expose the intended 39 tools");
  }

  const options = { timeout };
  const documents = await client.callTool(
    { name: "list_documents", arguments: {} },
    options,
  );
  const overview = await client.callTool(
    { name: "binary_overview", arguments: {} },
    options,
  );
  const segments = await client.callTool(
    { name: "list_segments", arguments: {} },
    options,
  );
  const procedures = await client.callTool(
    { name: "list_procedures", arguments: {} },
    options,
  );
  const procedureMap = jsonValue(procedures);
  const firstAddress = Object.keys(procedureMap)[0];
  if (firstAddress === undefined) {
    throw new Error("The verifier target contains no analyzed procedure");
  }
  const bounded = await client.callTool(
    { name: "batch_decompile", arguments: { addresses: [firstAddress] } },
    options,
  );

  const processList = await execFileAsync("ps", ["-ax", "-o", "command="]);
  const bundledMcpRunning = processList.stdout
    .split("\n")
    .some((line) => line.trim().endsWith("/HopperMCPServer"));
  if (bundledMcpRunning) {
    throw new Error(
      "Hopper's bundled MCP server was running during verification",
    );
  }
  if (stderrBytes !== 0) {
    throw new Error("The MCP runtime emitted stderr during verification");
  }

  summary = {
    toolCount: actualNames.length,
    documentCount: jsonValue(documents).length,
    overview: jsonValue(overview),
    segmentCount: jsonValue(segments).length,
    boundedTool: "batch_decompile",
    boundedInputCount: 1,
    boundedResultKeys: Object.keys(jsonValue(bounded)).length,
    bundledMcpRunning,
    stderrBytes,
  };
} finally {
  const keepAlive = setInterval(() => undefined, 100);
  try {
    await client.close();
    await transport.close();
  } finally {
    clearInterval(keepAlive);
  }
}

await new Promise((resolve) => setTimeout(resolve, 500));
const sessionsAfter = (await readdir("/tmp")).filter(
  (name) => name.startsWith("bbm-") && !sessionsBefore.has(name),
);
if (sessionsAfter.length > 0) {
  throw new Error("The MCP runtime leaked a bridge session directory");
}
const afterCloseProcesses = await execFileAsync("ps", [
  "-ax",
  "-o",
  "command=",
]);
if (
  afterCloseProcesses.stdout
    .split("\n")
    .some((line) => line.includes("node dist/main.js"))
) {
  throw new Error(
    "The TypeScript MCP server remained alive after client close",
  );
}
process.stdout.write(
  `${JSON.stringify({ ...summary, cleanShutdown: true }, null, 2)}\n`,
);
