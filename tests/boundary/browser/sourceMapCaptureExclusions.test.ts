import { expect, it } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

it("distinguishes unrequested maps, map exclusions, and usable map evidence", async () => {
  const modes = [
    "not-selected",
    "none",
    "excluded",
    "mixed",
    "redirect",
  ] as const;
  let mode: (typeof modes)[number] = modes[0];
  const localMap = "/app.js.map?token=map-secret";
  const foreignMap = "https://outside.example.test/main.js.map";
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Debugger.enable"],
    sourceMapBody: JSON.stringify({
      version: 3,
      names: [],
      sources: ["src/main.ts"],
      sourcesContent: ["export const original = true;"],
      mappings: "AAAA",
    }),
    sourceMapReply: (url, response) => {
      if (mode !== "redirect" || url !== localMap) return false;
      response.writeHead(302, { location: foreignMap }).end();
      return true;
    },
    commandEvents: (command, origin) => {
      if (command.method !== "Debugger.enable") return undefined;
      const script = (id: string, sourceMapURL?: string) => ({
        method: "Debugger.scriptParsed",
        sessionId: command.sessionId,
        params: {
          scriptId: id,
          url: `${origin}/${id}.js`,
          hash: id,
          isModule: true,
          executionContextId: 1,
          scriptLanguage: "JavaScript",
          ...(sourceMapURL === undefined ? {} : { sourceMapURL }),
        },
      });
      if (mode === "none") return [script("main")];
      if (mode === "mixed")
        return [script("main", foreignMap), script("second", localMap)];
      return [script("main", mode === "excluded" ? foreignMap : localMap)];
    },
  });
  trackBrowser(browser);
  const provider = new CdpBrowserProvider();
  const input = {
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
    observation_ms: 0,
  };
  const originalSource = `${browser.allowedOrigin}/src/main.ts`;
  try {
    for (const scenario of modes) {
      mode = scenario;
      const before = browser.httpRequests.length;
      const result = await provider.analyzeBundle(
        analyzeWebBundleInputSchema.parse({
          ...input,
          ...(mode === "not-selected" ? {} : { fetch_source_maps: true }),
        }),
      );
      if (!result.ok) throw result.error;
      const maps = result.value.observations.source_maps;
      if (mode === "none" || mode === "not-selected") {
        expect(maps, mode).toEqual({
          status: "not_requested",
          requested: 0,
          processed: 0,
          items: [],
        });
        expect(result.value.completeness.status, mode).toBe("complete");
        expect(result.value.unknowns, mode).toEqual([]);
      } else {
        expect(result.value.completeness.status, mode).toBe("partial");
        expect(result.value.unknowns, mode).toContainEqual(
          expect.objectContaining({ dimension: "source_maps" }),
        );
        if (mode === "redirect") {
          expect(maps, mode).toMatchObject({
            status: "unavailable",
            items: [{ status: "policy_filtered" }],
          });
          expect(maps.excluded).toBeUndefined();
        } else {
          expect(maps.excluded, mode).toEqual([
            { section: "source_maps", reason: "disallowed_origin", count: 1 },
          ]);
          if (mode === "excluded")
            expect(maps, mode).toMatchObject({
              status: "unavailable",
              requested: 0,
              processed: 0,
              items: [],
            });
          else
            expect(maps, mode).toMatchObject({
              status: "partial",
              requested: 1,
              processed: 1,
              items: [
                {
                  status: "included",
                  declared_url: `${browser.allowedOrigin}${localMap}`,
                  original_sources: [{ source: originalSource }],
                  mappings: [
                    {
                      generated_line: 1,
                      generated_column: 0,
                      source: originalSource,
                      original_line: 1,
                      original_column: 0,
                    },
                  ],
                },
              ],
            });
        }
      }
      expect(JSON.stringify(result.value), mode).not.toContain(
        "outside.example.test",
      );
      const mapRequests = browser.httpRequests
        .slice(before)
        .filter(({ url }) => url.startsWith("/app.js.map"));
      expect(mapRequests, mode).toEqual(
        mode === "mixed" || mode === "redirect"
          ? [
              {
                url: localMap,
                authorization: undefined,
                cookie: undefined,
                referer: undefined,
              },
            ]
          : [],
      );
    }
  } finally {
    await provider.close();
  }
});
