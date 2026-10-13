import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { listBrowserTargetsInputSchema } from "../../../src/domain/browserObservation.js";

describe("CDP target inventory", () => {
  it("returns every allowed target within the bounded discovery payload", async () => {
    let port = 0;
    const targets = Array.from({ length: 1_101 }, (_, index) => {
      const id = `target-${String(index).padStart(4, "0")}`;
      return {
        id,
        type: "page",
        title: `Page ${String(index)}`,
        url: `https://allowed.example/page/${String(index)}`,
        ...(index === 0 ? {} : { attached: index === 1 ? false : true }),
        webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/page/${id}`,
      };
    });
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/json/version") {
        response.end(
          JSON.stringify({
            Browser: "Chrome/1",
            "Protocol-Version": "1.3",
            "User-Agent": "Chrome",
            "V8-Version": "1",
            "WebKit-Version": "1",
            webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/browser/browser`,
          }),
        );
        return;
      }
      if (request.url === "/json/list") {
        response.end(JSON.stringify(targets));
        return;
      }
      response.writeHead(404).end();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new TypeError("Expected a TCP listener address");
      port = address.port;
      const endpoint = `http://127.0.0.1:${String(port)}`;

      const result = await new CdpBrowserProvider().listTargets(
        listBrowserTargetsInputSchema.parse({
          cdp_endpoint: endpoint,
          allowed_origins: ["https://allowed.example"],
        }),
      );

      if (!result.ok) throw result.error;
      expect(result.value.targets).toHaveLength(targets.length);
      expect(result.value.targets[0]?.target_id).toBe("target-0000");
      expect(result.value.targets.at(-1)?.target_id).toBe("target-1100");
      expect(
        result.value.targets.slice(0, 3).map(({ attached }) => attached),
      ).toEqual([null, false, true]);
      expect(
        result.value.limitations.some((item) =>
          item.includes("attachment state"),
        ),
      ).toBe(true);
    } finally {
      if (server.listening)
        await new Promise<void>((resolve, reject) => {
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          );
        });
    }
  });
});
