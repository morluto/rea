import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

import { expect, it } from "vitest";

import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";
import { fetchWebSourceMapsOk } from "../../fixtures/fetchWebSourceMapsOk.js";

it("selects original source language from decoded URL paths while retaining URL evidence", async () => {
  const typescriptContent = 'import "./dep.ts"; const value = <number>1;';
  const annotatedContent = 'import "./dep.ts"; const value: number = 1;';
  const javascriptContent = 'import "./dep.ts"; const value = 1;';
  const declarations = [
    {
      path: "plain.ts?revision=2#view.tsx",
      mediaType: "text/typescript",
      content: typescriptContent,
    },
    {
      path: "escaped%2Ets?revision=2#view.tsx",
      mediaType: "text/typescript",
      content: typescriptContent,
    },
    {
      path: "escaped.%74s?revision=2#view.tsx",
      mediaType: "text/typescript",
      content: typescriptContent,
    },
    {
      path: "escaped%2E%54S?revision=2#original.js",
      mediaType: "text/typescript",
      content: typescriptContent,
    },
    {
      path: "invalid%.ts?revision=2#view.tsx",
      mediaType: "text/typescript",
      content: typescriptContent,
    },
    {
      path: "view.tsx#original.ts",
      mediaType: "text/typescript",
      content: 'import "./dep.ts"; export const view: JSX.Element = <main />;',
    },
    {
      path: "module.mts",
      mediaType: "text/typescript",
      content: annotatedContent,
    },
    {
      path: "module.MTS",
      mediaType: "text/typescript",
      content: annotatedContent,
    },
    {
      path: "common.cts",
      mediaType: "text/typescript",
      content: annotatedContent,
    },
    {
      path: "main.js?filename=main.ts#original.ts",
      mediaType: "text/javascript",
      content: javascriptContent,
    },
    {
      path: "extensionless?revision=2",
      mediaType: "text/javascript",
      content: javascriptContent,
    },
  ];
  const text = JSON.stringify({
    version: 3,
    names: [],
    sources: declarations.map(({ path }) => path),
    sourcesContent: declarations.map(({ content }) => content),
    // One generated line per source, with the source index advancing each time.
    mappings: `AAAA${";ACAA".repeat(declarations.length - 1)}`,
  });
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" }).end(text);
  });
  try {
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("Expected TCP listener");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const url = `${origin}/maps/app.js.map`;
    const result = await fetchWebSourceMapsOk(
      [{ scriptKey: "script", declaredUrl: url, fetchUrl: url }],
      analyzeWebBundleInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "selected-page",
        allowed_origins: [origin],
        fetch_source_maps: true,
      }),
    );
    const sources = declarations.map(({ path, ...artifact }) => ({
      source: `${origin}/maps/${path}`,
      ...artifact,
    }));
    expect(requests).toEqual(["/maps/app.js.map"]);
    expect(result.status).toBe("included");
    expect(result.items[0]).toMatchObject({
      status: "included",
      limitation: null,
      artifact: { text },
      original_sources: sources.map(({ source, content, mediaType }) => ({
        source,
        artifact: {
          media_type: mediaType,
          text: content,
          bytes: Buffer.byteLength(content),
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      })),
      mappings: sources.map(({ source }, index) => ({
        generated_line: index + 1,
        source,
      })),
      original_module_edges: sources.map(({ source }) => ({
        from_source: source,
        kind: "static_import",
        specifier: "./dep.ts",
        resolved_source: `${origin}/maps/dep.ts`,
      })),
    });
  } finally {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
  }
});
