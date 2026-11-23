import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { webCaptureDiffSchema } from "../../../src/domain/webCaptureDiffSchemas.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import {
  unselectBodyShapes,
  passiveNetworkCapture,
  withPassiveDroppedEvents,
} from "../../fixtures/passiveNetworkCapture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const comparisonCases = () => {
  const before = unselectBodyShapes(passiveNetworkCapture());
  const after = unselectBodyShapes(passiveNetworkCapture(["/a", "/b"]));
  const limited = structuredClone(before);
  limited.completeness.attach_limited_sections.push("network_requests");
  const dropped = withPassiveDroppedEvents(before, { network_requests: 1 });
  const unknownRequest = structuredClone(before);
  unknownRequest.network.requests[0]!.resource_type = null;
  const knownRedirect = structuredClone(before);
  knownRedirect.network.requests[0]!.redirects = [
    {
      url: "https://app.example.test/start",
      response_url: "https://app.example.test/start",
      method: "GET",
      resource_type: "Document",
      status: 302,
      mime_type: "text/html",
      encoded_data_length: 20,
      request_timestamp: 1,
      redirect_event_timestamp: 2,
    },
  ];
  const unknownRedirect = structuredClone(knownRedirect);
  unknownRedirect.network.requests[0]!.redirects[0]!.resource_type = null;
  return [
    ["added", before, after, "added"],
    ["removed", after, before, "removed"],
    ["attachment-limited inventory", limited, after, null],
    ["dropped inventory", dropped, dropped, null],
    ["unknown request type", before, unknownRequest, null],
    ["unknown redirect type", knownRedirect, unknownRedirect, null],
  ] as const;
};

const cases = comparisonCases().map(([name, left, right, change]) => ({
  name,
  left,
  right,
  change,
}));

const expectComparison = (
  document: unknown,
  name: string,
  change: "added" | "removed" | null,
): void => {
  const evidence = parseEvidence(document);
  expect(evidence.operation).toBe("compare_web_captures");
  const result = webCaptureDiffSchema.parse(evidence.normalized_result);
  expect(result.dimensions.network, name).toMatchObject({
    status: change === null ? "unknown" : "changed",
    total_changes: change === null ? 0 : 1,
    changes:
      change === null
        ? []
        : [{ identity: expect.stringMatching(/^net_/u), change }],
  });
  expect(result.overall_status).toBe(change === null ? "unknown" : "changed");
};

cliTest.for(cases)(
  "CLI preserves passive inventory evidence: $name",
  async ({ name, left, right, change }, { cli }) => {
    const root = await createTestTempDirectory("rea-passive-inventory-");
    const paths = [
      join(root, "before.json"),
      join(root, "after.json"),
    ] as const;
    const serialized = [
      JSON.stringify({ inspection: left }),
      JSON.stringify({ inspection: right }),
    ];
    await Promise.all(
      paths.map((path, index) => writeFile(path, serialized[index]!)),
    );
    const options = {
      arguments: ["compare-web-captures", ...paths, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    };
    const response = await cli.run({
      ...options,
      freshProcess: name === "added" || name === "removed",
    });
    expect(response.exitCode, response.stderr).toBe(0);
    expectComparison(response.json, name, change);
    expect(
      await Promise.all(paths.map((path) => readFile(path, "utf8"))),
    ).toEqual(serialized);
  },
);

cliTest(
  "stdio MCP preserves passive inventory evidence on one owned connection",
  async () => {
    const mcp = await connectLocalToolsMcp();
    for (const { name, left, right, change } of cases) {
      const response = await mcp.call("compare_web_captures", {
        before: { inspection: left },
        after: { inspection: right },
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expectComparison(response.structuredContent, name, change);
    }
  },
);
