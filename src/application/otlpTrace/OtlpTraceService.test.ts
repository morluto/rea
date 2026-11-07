import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { inspectOtlpTraceEvidence } from "./OtlpTraceService.js";

it.each([998, 999, 1001])(
  "returns a typed failure with the verified file identity for a parent depth of %i",
  async (depth) => {
    let parent: unknown = "bad";
    for (let i = 0; i < depth; i++) parent = [parent];
    const input = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "1".repeat(32),
                  spanId: "2".repeat(16),
                  parentSpanId: parent,
                },
              ],
            },
          ],
        },
      ],
    });
    const path = join(
      await createTestTempDirectory("rea-otlp-deep-parent-"),
      "trace.json",
    );
    await writeFile(path, input);
    const resources = new ArtifactResourceScope();
    onTestFinished(() => resources.close());
    const result = await inspectOtlpTraceEvidence({ path }, resources);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected depth refusal");
    expect(result.error._tag).toBe("AnalysisInputError");
    expect(result.error.partialObservation).toMatchObject({
      kind: "file-snapshot-hash",
      path,
      sha256: createHash("sha256").update(input).digest("hex"),
      bytes: Buffer.byteLength(input),
    });
  },
);

it("admits a parent value that fits the Evidence nesting limit", async () => {
  let parent: unknown = "bad";
  for (let i = 0; i < 997; i++) parent = [parent];
  const input = JSON.stringify({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: "1".repeat(32),
                spanId: "2".repeat(16),
                parentSpanId: parent,
              },
            ],
          },
        ],
      },
    ],
  });
  const path = join(
    await createTestTempDirectory("rea-otlp-deep-control-"),
    "trace.json",
  );
  await writeFile(path, input);
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const result = await inspectOtlpTraceEvidence({ path }, resources);
  expect(result.ok).toBe(true);
});
