import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { inspectOtlpTraceEvidence } from "./OtlpTraceService.js";

it.each([
  ["timestamp", "9223372036854775808"],
  ["timestamp", "1.0000000000000001"],
  ["timestamp", `0.${"0".repeat(260)}`],
  ["span attribute", "9223372036854775808"],
  ["resource attribute", "9223372036854775808"],
])(
  "refuses a lossy JSON number in %s while retaining the file identity",
  async (kind, literal) => {
    const attribute = { key: "count", value: { intValue: "NUMERIC_LITERAL" } };
    const document = {
      resourceSpans: [
        {
          resource: {
            attributes: kind === "resource attribute" ? [attribute] : [],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "1".repeat(32),
                  spanId: "2".repeat(16),
                  ...(kind === "timestamp"
                    ? { startTimeUnixNano: "NUMERIC_LITERAL" }
                    : {}),
                  ...(kind === "span attribute"
                    ? { attributes: [attribute] }
                    : {}),
                },
              ],
            },
          ],
        },
      ],
    };
    const input = JSON.stringify(document).replace(
      '"NUMERIC_LITERAL"',
      literal,
    );
    const path = join(
      await createTestTempDirectory("rea-otlp-unsafe-number-"),
      "trace.json",
    );
    await writeFile(path, input);
    const resources = new ArtifactResourceScope();
    onTestFinished(() => resources.close());
    const result = await inspectOtlpTraceEvidence({ path }, resources);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected numeric refusal");
    expect(result.error._tag).toBe("AnalysisInputError");
    expect(result.error.partialObservation).toMatchObject({
      kind: "file-snapshot-hash",
      path,
      sha256: createHash("sha256").update(input).digest("hex"),
      bytes: Buffer.byteLength(input),
    });
  },
);

it.each(["timestamp", "span attribute", "resource attribute"])(
  "retains the file identity when a rejected %s value cannot fit Evidence",
  async (kind) => {
    let raw: unknown = "invalid";
    for (let i = 0; i < 1001; i += 1) raw = [raw];
    const attribute = { key: "count", value: { intValue: raw } };
    const input = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: kind === "resource attribute" ? [attribute] : [],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "1".repeat(32),
                  spanId: "2".repeat(16),
                  ...(kind === "timestamp" ? { startTimeUnixNano: raw } : {}),
                  ...(kind === "span attribute"
                    ? { attributes: [attribute] }
                    : {}),
                },
              ],
            },
          ],
        },
      ],
    });
    const path = join(
      await createTestTempDirectory("rea-otlp-rejected-value-"),
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

it("accepts exact numeric fields without interpreting unrelated similarly named data", async () => {
  const input =
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"11111111111111111111111111111111","spanId":"2222222222222222","startTimeUnixNano":42,"attributes":[{"key":"count","value":{"intValue":17}}],"unexamined":{"intValue":9223372036854775808}}]}]}]}';
  const path = join(
    await createTestTempDirectory("rea-otlp-safe-number-"),
    "trace.json",
  );
  await writeFile(path, input);
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const result = await inspectOtlpTraceEvidence({ path }, resources);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected an inventory");
  expect(result.value.evidence.normalized_result).toMatchObject({
    spans: [{ start_time_unix_nano: "42", attributes: [{ int_value: "17" }] }],
  });
});

it("accepts exact integer values written using JSON exponent and decimal forms", async () => {
  const input =
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"11111111111111111111111111111111","spanId":"2222222222222222","startTimeUnixNano":1e3,"attributes":[{"key":"count","value":{"intValue":1.0}}]}]}]}]}';
  const path = join(
    await createTestTempDirectory("rea-otlp-exact-decimal-"),
    "trace.json",
  );
  await writeFile(path, input);
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const result = await inspectOtlpTraceEvidence({ path }, resources);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected an inventory");
  expect(result.value.evidence.normalized_result).toMatchObject({
    spans: [{ start_time_unix_nano: "1000", attributes: [{ int_value: "1" }] }],
  });
});

it("detects a lossy numeric value under an escaped JSON key", async () => {
  const input =
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"11111111111111111111111111111111","spanId":"2222222222222222","attributes":[{"key":"count","value":{"int\\u0056alue":9223372036854775808}}]}]}]}]}';
  const path = join(
    await createTestTempDirectory("rea-otlp-escaped-key-"),
    "trace.json",
  );
  await writeFile(path, input);
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const result = await inspectOtlpTraceEvidence({ path }, resources);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected numeric refusal");
  expect(result.error._tag).toBe("AnalysisInputError");
  expect(result.error.partialObservation).toMatchObject({
    kind: "file-snapshot-hash",
    path,
    sha256: createHash("sha256").update(input).digest("hex"),
  });
});

it("reports the selected path and cause when the trace cannot be resolved", async () => {
  const root = await createTestTempDirectory("rea-otlp-missing-");
  const blocker = join(root, "file");
  await writeFile(blocker, "x");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  for (const [path, code] of [
    [join(root, "missing.json"), "ENOENT"],
    [join(blocker, "child.json"), "ENOTDIR"],
  ] as const) {
    const result = await inspectOtlpTraceEvidence({ path }, resources);
    expect(result.ok).toBe(false);
    if (result.ok || !(result.error instanceof AnalysisInputError))
      throw new Error("Expected input refusal");
    expect(result.error.issues).toEqual([
      {
        path: ["path"],
        reason: "invalid_format",
        message: `Selected trace could not be read (${code}): ${path}`,
      },
    ]);
  }
});
