import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { webPageInspectionSchema } from "../../../src/domain/browserObservationSchemas.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "owns recognized relation types per link through %s",
  async (surface, { cli }) => {
    const browser = await startFakeCdpBrowser({
      commandResult: (command, origin) =>
        command.method === "DOMSnapshot.captureSnapshot"
          ? {
              strings: [
                "#document",
                "html",
                "head",
                "link",
                "",
                "xmlns",
                "http://www.w3.org/1999/xhtml",
                "rel",
                `${"mcp ".repeat(150_000)}model-context model-context AI-PLUGIN`,
                "href",
                "/agent",
                `${origin}/root/page.xhtml`,
                "MCP service-desc service-desc mcp unrelated",
                "/other-agent",
              ],
              documents: [
                {
                  documentURL: 11,
                  nodes: {
                    nodeType: [9, 1, 1, 1, 1],
                    nodeName: [0, 1, 2, 3, 3],
                    nodeValue: [4, 4, 4, 4, 4],
                    parentIndex: [-1, 0, 1, 2, 2],
                    attributes: [[], [5, 6], [], [7, 8, 9, 10], [7, 12, 9, 13]],
                  },
                },
              ],
            }
          : undefined,
    });
    try {
      let document: unknown;
      if (surface === "CLI") {
        const reply = await cli.run({
          arguments: [
            "inspect-web-page",
            browser.endpoint,
            "allowed-page",
            "--observation-ms",
            "0",
            "--json",
          ],
        });
        expect(reply.exitCode, reply.stderr).toBe(0);
        document = reply.json;
      } else {
        const { call } = await connectLocalToolsMcp();
        const reply = await call("inspect_web_page", {
          cdp_endpoint: browser.endpoint,
          target_id: "allowed-page",
          observation_ms: 0,
        });
        expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
        document = reply.structuredContent;
      }
      const evidence = parseEvidence(document);
      expect(evidence.operation).toBe("inspect_web_page");
      const inspection = webPageInspectionSchema.parse(
        evidence.normalized_result,
      );
      expect(
        inspection.metadata.agent_hints.filter(
          ({ mechanism }) => mechanism === "dom_link_rel",
        ),
      ).toEqual(
        [
          ["mcp", "/agent"],
          ["model-context", "/agent"],
          ["ai-plugin", "/agent"],
          ["mcp", "/other-agent"],
          ["service-desc", "/other-agent"],
        ].map(([declaration, path]) => ({
          mechanism: "dom_link_rel",
          declaration,
          url: `${browser.allowedOrigin}${path}`,
          trust: "page-declared-untrusted",
        })),
      );
      expect(inspection.metadata.dom_urls).toEqual(
        ["/agent", "/other-agent"].map((path, index) => ({
          node_index: index + 3,
          attribute: "href",
          url: `${browser.allowedOrigin}${path}`,
          destination_scope: "approved",
        })),
      );
    } finally {
      await browser.close();
    }
  },
);
