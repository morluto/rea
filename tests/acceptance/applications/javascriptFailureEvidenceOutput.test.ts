import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { z } from "zod";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

// Inventory completes before the first JavaScript source reaches its 1 ms
// deadline, so the partial Evidence holds completed artifact facts and
// explicit unknowns for the sources that were not analyzed.
const application = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-js-failure-evidence-");
  await Promise.all(
    (
      [
        ["package.json", '{"name":"partial-delivery","main":"main.js"}'],
        ["main.js", "export const observed = 7;\n"],
        ["other.js", "localStorage.setItem('k', '1');\n"],
      ] as const
    ).map(([path, content]) => writeFile(join(root, path), content)),
  );
  return root;
};

const timeoutArguments = (root: string, ...extra: readonly string[]) => [
  "analyze-javascript-application",
  root,
  "--max-heap-mb",
  "128",
  "--analysis-timeout-ms",
  "1",
  ...extra,
  "--format",
  "json",
];

const failureSchema = z.object({
  code: z.literal("provider_timeout"),
  remediation: z.object({ action: z.string() }),
  details: z
    .object({
      partial_observation: z.unknown(),
      diagnostics: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
});

const nodeKinds = (normalized: unknown) =>
  javascriptApplicationAnalysisResultSchema
    .parse(normalized)
    .graph.nodes.map(({ kind }) => kind)
    .sort();

cliTest(
  "publishes partial Evidence to --evidence_output after a source deadline and keeps the reply compact",
  async ({ cli }) => {
    const root = await application();
    const output = join(
      await createTestTempDirectory("rea-js-failure-bundle-"),
      "partial.json",
    );
    const inline = await cli.run({ arguments: timeoutArguments(root) });
    expect(inline.exitCode).toBe(1);
    const inlineFailure = failureSchema.parse(inline.json);
    // Without --evidence_output the documented contract is unchanged.
    const inlinePartial = parseEvidence(
      inlineFailure.details.partial_observation,
    );
    expect(nodeKinds(inlinePartial.normalized_result)).toEqual(
      expect.arrayContaining(["artifact", "javascript-asset", "unknown"]),
    );
    expect(inlineFailure.details.diagnostics?.evidence_bundle).toBeUndefined();

    const summary = await cli.run({
      arguments: timeoutArguments(
        root,
        "--detail",
        "summary",
        "--evidence_output",
        output,
      ),
    });
    expect(summary.exitCode, summary.stderr).toBe(1);
    const failure = failureSchema.parse(summary.json);
    expect(failure.remediation.action).toContain("partial_observation");
    const receipt = z
      .object({ path: z.string(), bytes: z.number().int().positive() })
      .parse(failure.details.diagnostics?.evidence_bundle);
    expect(receipt.path).toBe(output);
    const bundleText = await readFile(output, "utf8");
    expect(Buffer.byteLength(bundleText)).toBe(receipt.bytes);
    const view = z
      .object({
        normalized_result: z.object({
          kind: z.literal("summary"),
          parent_evidence_id: z.string(),
          coverage: z.unknown(),
          limitations: z.array(z.string()),
        }),
      })
      .passthrough()
      .parse(failure.details.partial_observation);
    const record = parseEvidenceBundle(JSON.parse(bundleText)).records.find(
      ({ evidence_id: id }) => id === view.normalized_result.parent_evidence_id,
    );
    if (record === undefined)
      throw new Error("The published bundle lacks the partial Evidence");
    expect(record.operation).toBe("analyze_javascript_application");
    expect(nodeKinds(record.normalized_result)).toEqual(
      nodeKinds(inlinePartial.normalized_result),
    );
    expect(view.normalized_result.limitations.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(summary.stdout)).toBeLessThan(
      Buffer.byteLength(inline.stdout),
    );
  },
  60_000,
);

cliTest(
  "keeps partial Evidence inline when --evidence_output cannot be published",
  async ({ cli }) => {
    const root = await application();
    const output = join(
      await createTestTempDirectory("rea-js-failure-existing-"),
      "existing.json",
    );
    await writeFile(output, "kept");
    const response = await cli.run({
      arguments: timeoutArguments(
        root,
        "--detail",
        "summary",
        "--evidence_output",
        output,
      ),
    });
    expect(response.exitCode).toBe(1);
    const failure = failureSchema.parse(response.json);
    const partial = parseEvidence(failure.details.partial_observation);
    expect(nodeKinds(partial.normalized_result)).not.toHaveLength(0);
    expect(failure.details.diagnostics?.evidence_bundle).toBeUndefined();
    expect(failure.details.diagnostics?.evidence_bundle_error).toMatchObject({
      code: expect.any(String),
      message: expect.stringContaining("already exists"),
      limitation: expect.stringContaining("details.partial_observation"),
    });
    expect(await readFile(output, "utf8")).toBe("kept");
  },
  60_000,
);

// A one-line module finishes well within 5 s; a string-array-style module of
// 6,000 functions takes several times longer, so it reaches the deadline.
const slowModule = (): string => {
  const words = Array.from({ length: 4000 }, (_, i) => `w${i.toString(36)}`);
  const key = (i: number, n: number) => `_s(${String((i * 31 + n) % 4000)})`;
  return (
    `const _t=${JSON.stringify(words)};function _s(i){return _t[(i*7+3)%_t.length];}\n` +
    Array.from(
      { length: 6000 },
      (_, i) =>
        `export function f${String(i)}(a,b){const o={[${key(i, 1)}]:a,[${key(i, 2)}]:b};` +
        `if(o[${key(i, 3)}]>o[${key(i, 4)}]){return o[${key(i, 5)}]+${key(i, 6)};}` +
        `return window[${key(i, 7)}](o[${key(i, 8)}],o[${key(i, 9)}]);}\n`,
    ).join("")
  );
};

cliTest(
  "keeps a finished source's facts in the published partial Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-failure-finished-");
    await writeFile(
      join(root, "a.js"),
      "localStorage.setItem('finished.key', '1');\n",
    );
    await writeFile(join(root, "vendor.js"), slowModule());
    const output = join(
      await createTestTempDirectory("rea-js-failure-finished-bundle-"),
      "partial.json",
    );
    const response = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        "--analysis-timeout-ms",
        "5000",
        "--detail",
        "summary",
        "--evidence_output",
        output,
        "--format",
        "json",
      ],
    });
    expect(response.exitCode, response.stderr).toBe(1);
    const failure = failureSchema.parse(response.json);
    expect(failure.details.diagnostics?.evidence_bundle).toMatchObject({
      path: output,
    });
    const [record] = parseEvidenceBundle(
      JSON.parse(await readFile(output, "utf8")),
    ).records.filter(
      ({ operation }) => operation === "analyze_javascript_application",
    );
    if (record === undefined)
      throw new Error("The published bundle lacks the partial Evidence");
    const result = javascriptApplicationAnalysisResultSchema.parse(
      record.normalized_result,
    );
    expect(
      result.graph.nodes.filter(
        ({ kind, identity }) =>
          kind === "storage" &&
          JSON.stringify(identity).includes("finished.key"),
      ),
    ).toHaveLength(1);
    expect(record.limitations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^vendor\.js: .*timed out after 5000ms/u),
      ]),
    );
  },
  120_000,
);

// Drive the real staged publication of the partial Evidence across its
// commit point, as evidenceOutputPublicationCli does for successful results.
const publishPartialWithSeam = async (
  cli: TestCli,
  detail: "summary" | "complete",
  publication: Record<string, unknown>,
) => {
  const root = await application();
  const work = await createTestTempDirectory("rea-js-failure-seam-");
  const destination = join(work, "partial.json");
  const reply = await cli.run({
    cwd: work,
    arguments: timeoutArguments(
      root,
      "--detail",
      detail,
      "--evidence_output",
      destination,
    ),
    environment: {
      REA_TEST_EVIDENCE_PUBLICATION: JSON.stringify({
        prefix: join(await realpath(work), ".rea-write-"),
        marker: join(work, "signal.json"),
        ...publication,
      }),
      NODE_OPTIONS: `--max-old-space-size=2048 --import=${pathToFileURL(resolve("tests/fixtures/evidencePublicationPreload.mjs")).href}`,
    },
  });
  const staging = (await readdir(work)).filter((name) =>
    name.startsWith(".rea-write-"),
  );
  const bytes = await readFile(destination);
  const [record] = parseEvidenceBundle(JSON.parse(bytes.toString())).records;
  if (record === undefined)
    throw new Error("The published bundle lacks the partial Evidence");
  return { reply, destination, staging, bytes: bytes.length, record };
};

cliTest(
  "retains the original failure and committed receipt when staging cleanup stays incomplete",
  async ({ cli }) => {
    const { reply, destination, staging, bytes, record } =
      await publishPartialWithSeam(cli, "summary", { cleanup_failures: 1_000 });
    expect(reply.exitCode).toBe(1);
    const failure = failureSchema
      .extend({
        code: z.literal("cleanup_incomplete"),
        retryable: z.literal(false),
      })
      .parse(reply.json);
    expect(failure.remediation.action).toContain("cleanup");
    // The success path reports this outcome as details.published,
    // published_path, bytes and cleanup; the failure keeps the same shape.
    expect(failure.details).toMatchObject({
      published: true,
      published_path: destination,
      bytes,
      cleanup: "incomplete",
      execution_failure: "provider_timeout",
    });
    expect(failure.details.diagnostics?.evidence_bundle).toEqual({
      path: destination,
      bytes,
    });
    expect(failure.details.diagnostics?.evidence_bundle_error).toMatchObject({
      code: "cleanup_incomplete",
    });
    expect(failure.details.partial_observation).toMatchObject({
      normalized_result: {
        kind: "summary",
        parent_evidence_id: record.evidence_id,
      },
    });
    expect(staging).toHaveLength(1);
  },
  60_000,
);

cliTest(
  "delivers the receipt once a failed staging cleanup is confirmed by retry",
  async ({ cli }) => {
    const { reply, destination, staging, bytes, record } =
      await publishPartialWithSeam(cli, "summary", { cleanup_failures: 1 });
    expect(reply.exitCode).toBe(1);
    const failure = failureSchema.parse(reply.json);
    expect(failure.details.diagnostics?.evidence_bundle).toEqual({
      path: destination,
      bytes,
    });
    expect(failure.details.diagnostics).not.toHaveProperty(
      "evidence_bundle_error",
    );
    expect(failure.details.partial_observation).toMatchObject({
      normalized_result: { parent_evidence_id: record.evidence_id },
    });
    expect(staging).toEqual([]);
  },
  60_000,
);

cliTest(
  "keeps the original failure and the committed receipt when SIGINT arrives after commit",
  async ({ cli }) => {
    const { reply, destination, staging, bytes, record } =
      await publishPartialWithSeam(cli, "summary", {
        phase: "cleanup",
        signal: "SIGINT",
        delivery: process.platform === "win32" ? "event" : "os",
      });
    expect(reply.exitCode).toBe(130);
    const failure = failureSchema.parse(reply.json);
    expect(failure.details.diagnostics?.evidence_bundle).toEqual({
      path: destination,
      bytes,
    });
    expect(failure.details.diagnostics?.evidence_bundle_error).toMatchObject({
      code: "cancelled",
    });
    expect(failure.details.partial_observation).toMatchObject({
      normalized_result: {
        kind: "summary",
        parent_evidence_id: record.evidence_id,
      },
    });
    expect(staging).toEqual([]);
  },
  60_000,
);
