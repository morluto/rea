import { Client } from "@modelcontextprotocol/client";
import { parseConfig } from "../dist/config.js";
import { createBinaryNinjaTransport } from "../dist/binaryNinja/BinaryNinjaMcp.js";

const parsed = parseConfig(process.env);
if (!parsed.ok) throw parsed.error;
const config = parsed.value.binaryNinjaMcp;
if (config === undefined)
  throw new Error(
    "Set REA_BINARY_NINJA_MCP_URL or REA_BINARY_NINJA_MCP_COMMAND first.",
  );
const client = new Client({
  name: "rea-binary-ninja-inspection",
  version: "1",
});
try {
  await client.connect(createBinaryNinjaTransport(config), {
    timeout: config.timeoutMs,
  });
  const tools = [];
  let cursor;
  const cursors = new Set();
  do {
    const page = await client.listTools(
      cursor === undefined ? {} : { cursor },
      { timeout: config.timeoutMs },
    );
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor !== undefined && cursors.has(cursor))
      throw new Error("Server repeated a tools/list cursor");
    if (cursor !== undefined) cursors.add(cursor);
  } while (cursor !== undefined);
  process.stdout.write(
    `${JSON.stringify({ server: client.getServerVersion(), tools }, null, 2)}\n`,
  );
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  throw new Error(
    config.token === undefined
      ? message
      : message.replaceAll(config.token, "[redacted]"),
  );
} finally {
  await client.close();
}
