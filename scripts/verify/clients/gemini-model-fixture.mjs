import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Exercise the native Gemini API adapter against a local model, without cloud claims. */
export const createGeminiModelFixture = async ({ directory, onRequest }) => {
  const requests = [];
  const probes = [];
  let incoming = 0;
  let failure;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert(
          bytes <= 10 * 1024 * 1024,
          "Model fixture request exceeds 10 MiB budget",
        );
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw.length === 0 ? null : JSON.parse(raw);
      await writeFile(
        join(directory, `gemini-incoming-${++incoming}.json`),
        JSON.stringify({ method: request.method, path: request.url, body }),
      );
      const path = new URL(request.url, "http://localhost").pathname;
      if (path.endsWith(":countTokens")) {
        probes.push({ path, kind: "synthetic-token-count" });
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ totalTokens: 100 }));
        return;
      }
      if (
        !/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/u.test(
          path,
        )
      ) {
        probes.push({ path, status: 404 });
        response.statusCode = 404;
        response.end(
          JSON.stringify({
            error: { message: "Unsupported fixture endpoint" },
          }),
        );
        return;
      }
      assert.equal(request.method, "POST");
      assert(body && typeof body === "object" && !Array.isArray(body));
      assert(Array.isArray(body.contents));
      const tools = (body.tools ?? []).flatMap(
        (t) => t.functionDeclarations ?? [],
      );
      requests.push({
        path,
        tools: tools.map((t) => t.name),
        contentRoles: body.contents.map((c) => c.role),
      });
      const parts = await onRequest({
        body,
        tools,
        requestIndex: requests.length,
      });
      const result = {
        candidates: [
          { index: 0, content: { role: "model", parts }, finishReason: "STOP" },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 20,
          totalTokenCount: 120,
        },
        modelVersion: "local-rea-fixture",
      };
      if (path.endsWith(":streamGenerateContent")) {
        response.setHeader("Content-Type", "text/event-stream");
        response.end(`data: ${JSON.stringify(result)}\n\n`);
      } else {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(result));
      }
    } catch (cause) {
      failure = String(cause);
      response.statusCode = 400;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: { message: failure, code: 400 } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    probes,
    get failure() {
      return failure;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};
