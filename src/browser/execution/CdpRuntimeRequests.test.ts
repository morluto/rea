import { expect, it } from "vitest";
import { WEB_RUNTIME_LIMITS } from "../../domain/webRuntime.js";
import { receiveCdpEvent } from "../CdpConnection.js";
import { CdpRuntimeRequests } from "./CdpRuntimeRequests.js";

const origin = "https://example.test";
const sources = {
  session: {
    operation: "observe_web_execution" as const,
    allowedOrigins: new Set([origin]),
    target: { frame_id: "main" },
  },
  sourceUrl: (_scriptId: string, url: string) => url,
  location: (): never => {
    throw new Error("This parser-only initiator has no callsites");
  },
};
const event = (
  extraRequest: Record<string, string>,
  extraInitiator: Record<string, string> = {},
) => ({
  method: "Network.requestWillBeSent",
  params: {
    requestId: "request",
    frameId: "main",
    timestamp: 1,
    request: { url: `${origin}/resource`, method: "POST", ...extraRequest },
    initiator: { type: "parser", ...extraInitiator },
  },
});

it("budgets retained request facts independently of discarded POST bodies", () => {
  const requests = new CdpRuntimeRequests(sources);
  requests.ingest(
    receiveCdpEvent(
      event({
        postData: "p".repeat(WEB_RUNTIME_LIMITS.retainedEventBytes + 1),
      }),
    ),
  );
  const retained = requests.result();
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatchObject({
    method: "POST",
    reported_initiator: { type: "parser" },
  });
  expect(JSON.stringify(retained)).not.toContain("postData");
});

it("preserves a typed resource refusal for oversized retained initiator facts", () => {
  const requests = new CdpRuntimeRequests(sources);
  requests.ingest(
    receiveCdpEvent(
      event(
        {},
        { retained: "r".repeat(WEB_RUNTIME_LIMITS.retainedEventBytes + 1) },
      ),
    ),
  );
  expect(() => requests.result()).toThrow(
    expect.objectContaining({
      _tag: "AnalysisResourceConstraintError",
      operation: "observe_web_execution",
      resource: "capacity",
      reportedLimits: expect.objectContaining({
        boundary: "browser-runtime-retention",
        kind: "requests",
        limit_bytes: WEB_RUNTIME_LIMITS.retainedEventBytes,
      }),
    }),
  );
});
