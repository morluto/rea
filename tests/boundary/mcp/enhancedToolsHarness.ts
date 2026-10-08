import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  jsonValueSchema,
  type JsonValue,
} from "../../../src/domain/jsonValue.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { createServer } from "../../../src/server/createServer.js";

export const PROCEDURES = {
  "0x1": "_TtC7Fixture5Class",
  "0x2": "_TtV7Fixture6Struct",
  "0x3": "_TtP7Fixture8Protocol",
  "0x4": "_TtO7Fixture4Enum",
  "0x5": "_TtE7Fixture9Extension",
  "0x6": "prefix_TtOther",
};

export const inventory = (values: Readonly<Record<string, string>>) =>
  Object.entries(values).map(([address, value]) => ({ address, value }));

export const resources: Array<{ close(): Promise<void> }> = [];

export const connect = async (analysis: AnalysisOperationPort) => {
  const server = createServer(analysis);
  const client = new Client({ name: "enhanced-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

/** Close every client/server pair opened by `connect` in this module. */
export const closeEnhancedToolResources = async (): Promise<void> => {
  await Promise.all(
    resources.splice(0).map(async (resource) => resource.close()),
  );
};

export const jsonResult = (result: CallToolResult): JsonValue => {
  if (result.structuredContent === undefined)
    throw new Error("Tool result omitted structured content");
  const structured = jsonValueSchema.safeParse(result.structuredContent);
  if (!structured.success)
    throw new Error("Tool structured result was not JSON");
  if (
    typeof structured.data === "object" &&
    structured.data !== null &&
    !Array.isArray(structured.data) &&
    "normalized_result" in structured.data
  ) {
    return structured.data.normalized_result ?? null;
  }
  if (
    typeof structured.data === "object" &&
    structured.data !== null &&
    !Array.isArray(structured.data) &&
    "evidence_id" in structured.data &&
    "result" in structured.data
  )
    return structured.data.result ?? null;
  const text = result.content.find((item) => item.type === "text");
  if (text?.type !== "text")
    throw new Error("Tool result omitted text content");
  const decoded: unknown = JSON.parse(text.text);
  const parsed = jsonValueSchema.safeParse(decoded);
  if (!parsed.success) throw new Error("Tool result was not JSON");
  return parsed.data;
};
