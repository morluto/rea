import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { z } from "zod";
import { createVerifierHttpServer } from "../../../../scripts/lib/verifier-http-server.mjs";
import { JebProvider } from "../../../../src/jeb/JebProvider.js";
import { JEB_ENGINE_TOOLS } from "../../../../src/jeb/JebMcpConnection.js";
import type { JsonValue } from "../../../../src/domain/jsonValue.js";
import { createServer } from "../../../../src/server/createServer.js";
import { createTestBinarySession } from "../../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../../fixtures/mcpSchemaValidation.js";

const requestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z
    .object({ name: z.string().optional(), arguments: z.unknown().optional() })
    .passthrough()
    .optional(),
});

// Exercise the SDK decoder and the public REA tool together. The producer serves
// both documented envelope encodings without mocking either MCP client.
const startProducer = async (
  payload: JsonValue,
  encoding: "structured" | "json-text",
) => {
  const calls: unknown[] = [];
  const { server, close } = createVerifierHttpServer(
    async (request, response) => {
      if (request.method !== "POST") {
        request.resume();
        response.writeHead(request.method === "DELETE" ? 200 : 405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const message = requestSchema.parse(JSON.parse(body));
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (message.method === "initialize") {
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "jeb-failure-envelope", version: "1" },
        };
      } else if (message.method === "tools/list") {
        result = {
          tools: Object.values(JEB_ENGINE_TOOLS).map((name) => ({
            name,
            inputSchema: { type: "object", properties: {} },
          })),
        };
      } else if (message.method === "tools/call") {
        calls.push(message.params);
        result = {
          isError: true,
          ...(encoding === "structured" ? { structuredContent: payload } : {}),
          content: [{ type: "text", text: JSON.stringify(payload) }],
        };
      } else throw new Error(`Unexpected producer request: ${message.method}`);
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP listener");
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, calls, close };
};

const failures: { name: string; payload: JsonValue; message: string }[] = [
  {
    name: "required recovery",
    payload: {
      success: false,
      error: {
        code: "ENGINE_NOT_READY",
        message: "Engine requires recovery",
        recovery_required_before_retry: true,
        recovery_tool: "recover_engine",
      },
      message: "Outer status",
      metadata: {
        selected_artifact: "caller-secret.apk",
        details: ["preserve me"],
      },
    },
    message: "Engine requires recovery",
  },
  {
    name: "recovery explicitly unnecessary",
    payload: {
      success: false,
      error: {
        code: "INVALID_ITEM",
        message: "",
        recovery_required_before_retry: false,
        recovery_tool: "recover_engine",
      },
      message: "Selected item is unavailable",
    },
    message: "Selected item is unavailable",
  },
  {
    name: "omitted recovery and empty messages",
    payload: {
      success: false,
      error: { code: "PROJECT_BUSY", message: "" },
      message: "",
    },
    message: "PROJECT_BUSY",
  },
  {
    name: "outer message without nested error",
    payload: { success: false, message: "Project cannot be opened" },
    message: "Project cannot be opened",
  },
];

const input = { path: "./selected target/caller-secret.apk" };

/** Serve one refusal to the public open_jeb_project tool and project it. */
const refuseOpenProject = async (
  payload: JsonValue,
  encoding: "structured" | "json-text",
) => {
  const producer = await startProducer(payload, encoding);
  const provider = new JebProvider({
    environment: { REA_JEB_MCP_URL: producer.endpoint },
  });
  const session = createTestBinarySession(() => {
    throw new Error("JEB must not start a deep provider");
  });
  const server = createServer(
    { kind: "session", session },
    { jebAnalysis: provider, environment: {} },
  );
  const client = new Client(
    { name: "jeb-failure-contract", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  try {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "open_jeb_project",
      arguments: input,
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    expect(producer.calls).toEqual([
      { name: "open_project", arguments: { file_path: input.path } },
    ]);
    return { projected: JSON.parse(text), endpoint: producer.endpoint };
  } finally {
    try {
      await client.close();
    } finally {
      try {
        await server.close();
      } finally {
        try {
          await session.close();
        } finally {
          try {
            await provider.close();
          } finally {
            await producer.close();
          }
        }
      }
    }
  }
};

const encodings = ["structured", "json-text"] as const;

it.each(
  failures.flatMap((failure) =>
    encodings.map((encoding) => ({ ...failure, encoding })),
  ),
)(
  "projects $encoding $name as execution failure with the original envelope",
  async ({ payload, message, encoding }) => {
    const { projected, endpoint } = await refuseOpenProject(payload, encoding);
    expect(projected.error).toMatchObject({
      code: "execution_failure",
      message,
    });
    expect(projected.error.details.diagnostics).toEqual({
      endpoint,
      upstream_response: payload,
      input,
    });
  },
);

const exhaustion: {
  name: string;
  payload: JsonValue;
  resource: string;
  area: string | null;
  remediation: RegExp;
}[] = [
  {
    name: "heap space in the nested error",
    payload: {
      success: false,
      error: {
        code: "ENGINE_FAILURE",
        message: "java.lang.OutOfMemoryError: Java heap space",
      },
    },
    resource: "memory",
    area: "heap",
    remediation: /larger maximum heap \(-Xmx\)/u,
  },
  {
    name: "metaspace in the nested error",
    payload: {
      success: false,
      error: { message: "java.lang.OutOfMemoryError: Metaspace" },
    },
    resource: "memory",
    area: "metaspace",
    remediation: /-XX:MaxMetaspaceSize; a larger heap \(-Xmx\) does not/u,
  },
  {
    name: "an oversized array in the outer message",
    payload: {
      success: false,
      message:
        "java.lang.OutOfMemoryError: Requested array size exceeds VM limit",
    },
    resource: "memory",
    area: "array-size",
    remediation: /does not lift this limit\. Select a smaller input/u,
  },
  {
    name: "an unnamed area in the outer message",
    payload: { success: false, message: "java.lang.OutOfMemoryError" },
    resource: "memory",
    area: null,
    remediation: /Review the reported out-of-memory line/u,
  },
  {
    name: "native-thread exhaustion",
    payload: {
      success: false,
      message:
        "java.lang.OutOfMemoryError: unable to create native thread: possibly out of memory",
    },
    resource: "capacity",
    area: "native-thread",
    remediation: /could not create a native thread/u,
  },
];

it.each(
  exhaustion.flatMap((failure) =>
    encodings.map((encoding) => ({ ...failure, encoding })),
  ),
)(
  "reports $encoding JVM exhaustion with $name as a resource constraint",
  async ({ payload, resource, area, remediation, encoding }) => {
    const { projected, endpoint } = await refuseOpenProject(payload, encoding);
    expect(projected.error.code).toBe("resource_constraint");
    expect(projected.error.details).toMatchObject({
      resource,
      diagnostics: {
        endpoint,
        upstream_response: payload,
        input,
        jvm_exhaustion_area: area,
      },
    });
    expect(projected.error.remediation.action).toMatch(remediation);
  },
);
