import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { webPageInspectionSchema } from "../../../src/domain/browserObservationSchemas.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { runCliJson } from "../../fixtures/cliJsonProcess.js";
import { startHttpComparisonBrowser } from "../../fixtures/httpComparisonBrowser.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("CLI compares incomplete HTTP responses without inventing changes", async () => {
  const root = await createTestTempDirectory("rea-http-comparison-");
  const response = {
    requestId: "request-1",
    status: 200,
    mimeType: "application/json",
  };
  const fixture = await startHttpComparisonBrowser([response]);
  try {
    const inspect = async () =>
      webPageInspectionSchema.parse(
        parseEvidence(
          await runCliJson([
            "inspect-web-page",
            fixture.browser.endpoint,
            "allowed-page",
            "--observation-ms",
            "0",
            "--json",
          ]),
        ).normalized_result,
      );
    const pending = await inspect();
    fixture.setRequests([{ ...response, encodedDataLength: 100 }]);
    const finished = await inspect();
    fixture.setRequests([{ ...response, status: 500, encodedDataLength: 100 }]);
    const changed = await inspect();
    expect(pending.network.requests).toMatchObject([
      { status: 200, mime_type: "application/json", encoded_data_length: null },
    ]);
    expect(finished.network.requests).toMatchObject([
      { status: 200, mime_type: "application/json", encoded_data_length: 100 },
    ]);
    const paths = [pending, finished, changed].map((_, index) =>
      join(root, `capture-${String(index)}.json`),
    );
    await Promise.all(
      [pending, finished, changed].map((inspection, index) =>
        writeFile(paths[index]!, JSON.stringify({ inspection })),
      ),
    );
    for (const [left, right, status, count] of [
      [0, 1, "unknown", 0],
      [1, 0, "unknown", 0],
      [0, 2, "changed", 1],
    ] as const) {
      const compared = await runCliJson([
        "compare-web-captures",
        paths[left]!,
        paths[right]!,
        "--json",
      ]);
      expect(compared).toMatchObject({
        operation: "compare_web_captures",
        normalized_result: {
          overall_status: status,
          dimensions: {
            network: { status, total_changes: count },
          },
        },
      });
    }
  } finally {
    await fixture.browser.close();
  }
}, 60_000);
