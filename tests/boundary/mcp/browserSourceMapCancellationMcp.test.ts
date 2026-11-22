import { expect, it, onTestFinished } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { webBundleAcquisitionPartialObservationSchema } from "../../../src/domain/webBundleAnalysis.js";
import { startSourceMapCancellationBrowser } from "../../fixtures/browserSourceMapCancellation.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import {
  createApplicationMcpHarness,
  type ApplicationMcpHarness,
} from "../../fixtures/applicationMcpHarness.js";
import { waitFor } from "../../support/testWait.js";

it("retains completed source maps through MCP cancellation for later Evidence retrieval", async () => {
  const {
    browser,
    mapText,
    completedMapPath,
    secondRequest,
    releasePendingResponse,
    close,
  } = await startSourceMapCancellationBrowser();
  const controller = new AbortController();
  let harness: ApplicationMcpHarness | undefined;
  onTestFinished(async () => {
    controller.abort();
    releasePendingResponse();
    try {
      await harness?.close();
    } finally {
      await close();
    }
  });
  const connected = await createApplicationMcpHarness({
    serverOptions: { browserObservation: new CdpBrowserProvider() },
  });
  harness = connected;

  const call = connected.client.callTool(
    {
      name: "analyze_web_bundle",
      arguments: {
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
        fetch_source_maps: true,
      },
    },
    { signal: controller.signal },
  );
  await awaitAcknowledgement(secondRequest, call, "second source-map request");
  const retainedMapPath = await completedMapPath;
  controller.abort(new Error("Caller cancelled after the first map"));
  await expect(call).rejects.toThrow();

  // The SDK suppresses the cancelled reply. Wait for the public Evidence bundle
  // to publish the acquisition after cleanup.
  const evidence = await waitFor(async () => {
    const reply = await connected.client.callTool({
      name: "get_evidence_bundle",
      arguments: { detail: "complete" },
    });
    expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
    const bundle = toolContract("get_evidence_bundle").outputSchema.parse(
      reply.structuredContent,
    ).result;
    if ("kind" in bundle) throw new Error("Expected complete Evidence bundle");
    const records = bundle.records.filter(
      ({ operation }) => operation === "analyze_web_bundle",
    );
    expect(records).toHaveLength(1);
    const record = records[0];
    if (record === undefined) throw new Error("Expected retained acquisition");
    return record;
  });
  const acquisition = webBundleAcquisitionPartialObservationSchema.parse(
    evidence.normalized_result,
  );
  expect(acquisition.analysis_status).toBe("not_performed");
  expect(acquisition.source_maps).toMatchObject({
    status: "partial",
    requested: 2,
    processed: 1,
    items: [
      {
        status: "included",
        declared_url: `${browser.allowedOrigin}${retainedMapPath}`,
        artifact: {
          text: mapText,
        },
      },
    ],
  });
  expect(browser.activeConnectionCount()).toBe(0);
});
