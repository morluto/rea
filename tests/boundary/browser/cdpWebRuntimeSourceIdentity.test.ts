import { expect, it, onTestFinished } from "vitest";
import type { CdpEvent } from "../../../src/browser/CdpConnection.js";
import { CdpWebRuntimeProvider } from "../../../src/browser/execution/CdpWebRuntimeProvider.js";
import { observeWebExecutionInputSchema } from "../../../src/domain/webExecution.js";
import { inspectWebEventListenersInputSchema } from "../../../src/domain/webEventListeners.js";
import { startRuntimeBrowser } from "../../fixtures/webRuntime.js";

it.each(
  ["listeners", "execution"].flatMap((operation) =>
    ["source_read", "other_source_read", "final_assertion"].map((phase) => ({
      operation,
      phase,
    })),
  ),
)(
  "revalidates $operation joins when a known script changes at $phase",
  async ({ operation, phase }) => {
    let emit: ((event: CdpEvent) => void) | undefined;
    const browser = await startRuntimeBrowser({
      commandResult: (command, origin, reads) => {
        if (
          (phase === "source_read" &&
            command.method === "Debugger.getScriptSource" &&
            command.params.scriptId === "script-a") ||
          (phase === "other_source_read" &&
            command.method === "Debugger.getScriptSource" &&
            command.params.scriptId === "script-b") ||
          (phase === "final_assertion" &&
            command.method === "Page.getFrameTree" &&
            reads === (operation === "listeners" ? 3 : 4))
        )
          emit?.({
            sessionId: "session-1",
            method: "Debugger.scriptParsed",
            params: {
              scriptId: "script-a",
              url: `${origin}/changed.js`,
              executionContextId: 1,
              executionContextAuxData: { frameId: "runtime-main" },
              startLine: 0,
              startColumn: 0,
              endLine: 1,
              endColumn: 0,
              hash: "changed-producer-hash",
              hasSourceURL: true,
              scriptLanguage: "JavaScript",
            },
          });
        if (command.method === "DOMDebugger.getEventListeners")
          return {
            listeners: ["script-a", "script-b"].map((scriptId) => ({
              type: "click",
              useCapture: false,
              passive: true,
              once: false,
              scriptId,
              lineNumber: 0,
              columnNumber: 0,
            })),
          };
        return undefined;
      },
    });
    emit = browser.emitEvent;
    onTestFinished(() => browser.close());
    const provider = new CdpWebRuntimeProvider();
    const scope = { cdp_endpoint: browser.endpoint, target_id: "allowed-page" };
    if (operation === "listeners") {
      const result = await provider.inspectEventListeners(
        inspectWebEventListenersInputSchema.parse({
          ...scope,
          selector: "#selected",
        }),
      );
      if (!result.ok) throw result.error;
      expect(result.value.listeners[0]?.location.source_association).toBe(
        "unknown",
      );
      expect(result.value.sources[0]).toMatchObject({
        frame_id: null,
        source: { state: "excluded" },
      });
    } else {
      const result = await provider.observeExecution(
        observeWebExecutionInputSchema.parse({ ...scope, observation_ms: 5 }),
        {
          progress: {
            report: async (update) => {
              if (update.completed !== 1) return;
              browser.emitEvent({
                sessionId: "session-1",
                method: "Network.requestWillBeSent",
                params: {
                  requestId: "source-completion-request",
                  frameId: "runtime-main",
                  timestamp: 12,
                  request: {
                    url: `${new URL(browser.endpoint).origin}/selected`,
                    method: "GET",
                  },
                  initiator: {
                    type: "script",
                    stack: {
                      callFrames: [
                        {
                          scriptId: "script-a",
                          url: `${new URL(browser.endpoint).origin}/same.js`,
                          lineNumber: 0,
                          columnNumber: 0,
                          functionName: "selected",
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
        result.value.coverage.scripts.some(
          ({ script_id }) => script_id === "script-a",
        ),
      ).toBe(false);
      expect(result.value.requests[0]?.callsites[0]?.source_association).toBe(
        "unknown",
      );
      expect(result.value.script_inventory.main_document_scripts).toBe(1);
      expect(
        result.value.sources.find(({ script_id }) => script_id === "script-a"),
      ).toMatchObject({ frame_id: null, source: { state: "excluded" } });
    }
  },
);
