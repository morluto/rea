import { describe, expect, it, onTestFinished } from "vitest";
import { CdpWebRuntimeProvider } from "../../../src/browser/execution/CdpWebRuntimeProvider.js";
import { observeWebExecutionInputSchema } from "../../../src/domain/webExecution.js";
import {
  negativeColumnScript,
  negativeColumnScriptUrl,
  startNegativeColumnBrowser,
  startRuntimeBrowser,
} from "../../fixtures/webRuntime.js";

describe("runtime collector failure and uncertain source metadata", () => {
  it.each(["Debugger.scriptParsed", "Network.requestWillBeSent"])(
    "stops an armed long window immediately for malformed %s",
    async (method) => {
      const browser = await startRuntimeBrowser();
      onTestFinished(() => browser.close());
      const result = await new CdpWebRuntimeProvider().observeExecution(
        observeWebExecutionInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          target_id: "allowed-page",
          observation_ms: 2_147_483_647,
        }),
        {
          signal: AbortSignal.timeout(2_000),
          progress: {
            report: async (update) => {
              if (update.completed === 1)
                browser.emitEvent({
                  method,
                  params: {},
                  sessionId: "session-1",
                });
            },
          },
        },
      );
      if (result.ok) throw new Error("Malformed producer data must fail");
      expect(result.error._tag).toBe("AnalysisOutputError");
      expect(
        browser.commands.some(
          ({ method: command }) => command === "Profiler.stopPreciseCoverage",
        ),
      ).toBe(true);
      expect(
        browser.commands.some(
          ({ method: command }) => command === "Target.detachFromTarget",
        ),
      ).toBe(true);
    },
  );

  it("retains reported metadata without claiming ownership or reading unowned source", async () => {
    const browser = await startRuntimeBrowser();
    onTestFinished(() => browser.close());
    const script = {
      scriptId: "uncertain-script",
      url: `${browser.endpoint}/declared.js?caller=value#fragment`,
      executionContextId: 999,
      hash: "observed-hash",
      sourceMapURL: "../declared.map?query=value#fragment",
      hasSourceURL: true,
      scriptLanguage: "JavaScript",
      startLine: 4,
      startColumn: 8,
      endLine: 8,
      endColumn: 0,
    };
    const result = await new CdpWebRuntimeProvider().observeExecution(
      observeWebExecutionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        observation_ms: 30,
      }),
      {
        progress: {
          report: async (update) => {
            if (update.completed !== 1) return;
            browser.emitEvent({
              method: "Debugger.scriptParsed",
              params: script,
              sessionId: "session-1",
            });
            browser.emitEvent({
              method: "Network.requestWillBeSent",
              sessionId: "session-1",
              params: {
                requestId: "uncertain-request",
                frameId: "runtime-main",
                timestamp: 12,
                request: { url: `${browser.endpoint}/request`, method: "GET" },
                initiator: {
                  type: "script",
                  stack: {
                    callFrames: [
                      {
                        scriptId: script.scriptId,
                        url: script.url,
                        functionName: "unknown",
                        lineNumber: 4,
                        columnNumber: 8,
                      },
                    ],
                  },
                },
              },
            });
          },
        },
      },
    );
    if (!result.ok) throw result.error;
    expect(
      result.value.sources.find(
        ({ script_id }) => script_id === script.scriptId,
      ),
    ).toMatchObject({
      url: script.url,
      execution_context_id: 999,
      frame_id: null,
      producer_hash: script.hash,
      source_map_url: script.sourceMapURL,
      has_source_url: true,
      language: "JavaScript",
      resource_start: { line_number: 4, column_number: 8 },
      source: { state: "excluded" },
    });
    expect(result.value.requests[0]?.callsites[0]?.source_association).toBe(
      "unknown",
    );
    expect(
      browser.commands.some(
        ({ method, params }) =>
          method === "Debugger.getScriptSource" &&
          params.scriptId === script.scriptId,
      ),
    ).toBe(false);
  });
});

it("keeps negative columns Chrome reports for an inline script and its first-line callsites", async () => {
  const browser = await startNegativeColumnBrowser();
  onTestFinished(() => browser.close());
  const scriptUrl = negativeColumnScriptUrl(browser.endpoint);
  const result = await new CdpWebRuntimeProvider().observeExecution(
    observeWebExecutionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "allowed-page",
      observation_ms: 30,
    }),
    {
      progress: {
        report: async (update) => {
          if (update.completed !== 1) return;
          for (const [requestId, initiator] of [
            [
              "script-request",
              {
                type: "script",
                stack: {
                  callFrames: [
                    {
                      scriptId: negativeColumnScript.scriptId,
                      url: scriptUrl,
                      functionName: "",
                      lineNumber: 21,
                      columnNumber: -40,
                    },
                  ],
                },
              },
            ],
            [
              "parser-request",
              {
                type: "parser",
                url: scriptUrl,
                lineNumber: 21,
                columnNumber: -30,
              },
            ],
          ] as const)
            browser.emitEvent({
              method: "Network.requestWillBeSent",
              sessionId: "session-1",
              params: {
                requestId,
                frameId: "runtime-main",
                timestamp: 12,
                request: {
                  url: `${browser.endpoint}/${requestId}`,
                  method: "GET",
                },
                initiator,
              },
            });
        },
      },
    },
  );
  if (!result.ok) throw result.error;
  expect(
    result.value.requests.map(({ callsites }) =>
      callsites.map(({ script_id, line_number, column_number }) => ({
        script_id,
        line_number,
        column_number,
      })),
    ),
  ).toEqual([
    [
      {
        script_id: negativeColumnScript.scriptId,
        line_number: 21,
        column_number: -40,
      },
    ],
    [{ script_id: "", line_number: 21, column_number: -30 }],
  ]);
  expect(result.value.sources).toContainEqual(
    expect.objectContaining({
      script_id: negativeColumnScript.scriptId,
      resource_start: { line_number: 21, column_number: -60 },
    }),
  );
});
