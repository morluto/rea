import { execFile } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import {
  JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
  JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE,
  JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
  JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE,
} from "../src/contracts/javascriptApplicationWorkflowExamples.js";
import {
  createEvidenceBundle,
  serializeEvidenceBundle,
} from "../src/domain/evidenceBundle.js";
import { analyzeJavaScriptApplication } from "../src/application/JavaScriptApplicationService.js";
import { permissionAuthorityForRoot } from "./fixtures/permissionAuthority.js";

const execute = promisify(execFile);

describe("application workflow CLI parity", () => {
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporary
        .splice(0)
        .map(async (path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("accepts inline trace JSON and file-backed comparison JSON", async () => {
    const traced = await runCli([
      "trace-application-feature",
      JSON.stringify(JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE),
      "--json",
    ]);
    expect(traced).toMatchObject({
      operation: "trace_application_feature",
      normalized_result: { schema_version: 1 },
    });

    const root = await createTestTempDirectory("rea-application-cli-");
    temporary.push(root);
    const comparisonPath = join(root, "comparison.json");
    await writeFile(
      comparisonPath,
      JSON.stringify(JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE),
    );
    const compared = await runCli([
      "compare-application-versions",
      comparisonPath,
      "--json",
    ]);
    expect(compared).toMatchObject({
      operation: "compare_application_versions",
      normalized_result: {
        schema_version: 1,
        summary: { unknown: expect.any(Number) },
      },
    });
  }, 20_000);

  it("resolves Evidence IDs from an explicitly authorized bundle", async () => {
    const root = await createTestTempDirectory("rea-application-bundle-cli-");
    temporary.push(root);
    const bundlePath = join(root, "evidence.json");
    await writeFile(
      bundlePath,
      serializeEvidenceBundle(
        createEvidenceBundle([
          JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.left,
          JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.right,
        ]),
      ),
    );
    const environment = {
      REA_EVIDENCE_ROOTS_JSON: JSON.stringify([root]),
    };

    const traced = await runCli(
      [
        "trace-application-feature",
        JSON.stringify({
          ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
          application_evidence_id:
            JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE.application
              .evidence_id,
        }),
        "--evidence-bundle",
        bundlePath,
        "--json",
      ],
      environment,
    );
    expect(traced).toMatchObject({
      operation: "trace_application_feature",
      normalized_result: { schema_version: 1 },
    });

    const compared = await runCli(
      [
        "compare-application-versions",
        JSON.stringify({
          ...JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
          left_evidence_id:
            JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.left
              .evidence_id,
          right_evidence_id:
            JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.right
              .evidence_id,
        }),
        "--evidence-bundle",
        bundlePath,
        "--json",
      ],
      environment,
    );
    expect(compared).toMatchObject({
      operation: "compare_application_versions",
      normalized_result: { schema_version: 1 },
    });

    const missingRecord = await runCli(
      [
        "trace-application-feature",
        JSON.stringify(JAVASCRIPT_FEATURE_TRACE_EXAMPLE),
        "--evidence-bundle",
        bundlePath,
        "--json",
      ],
      environment,
    );
    expect(missingRecord).toMatchObject({
      code: "evidence_integrity_mismatch",
      details: { reason: "missing" },
    });

    const outsideRoot = await createTestTempDirectory(
      "rea-outside-bundle-cli-",
    );
    temporary.push(outsideRoot);
    const outsideBundlePath = join(outsideRoot, "evidence.json");
    await writeFile(
      outsideBundlePath,
      serializeEvidenceBundle(createEvidenceBundle([])),
    );
    const denied = await runCli(
      [
        "trace-application-feature",
        JSON.stringify(JAVASCRIPT_FEATURE_TRACE_EXAMPLE),
        "--evidence-bundle",
        outsideBundlePath,
        "--json",
      ],
      environment,
    );
    expect(denied).toMatchObject({ code: "permission_required" });
  }, 20_000);

  it("compares exact export shapes from an authorized Evidence bundle", async () => {
    const root = await createTestTempDirectory("rea-export-shape-cli-");
    temporary.push(root);
    const leftRoot = join(root, "left");
    const rightRoot = join(root, "right");
    await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);
    await Promise.all([
      copyFile(
        join(process.cwd(), "tests/fixtures/replay/parser.mjs"),
        join(leftRoot, "parser.mjs"),
      ),
      copyFile(
        join(process.cwd(), "tests/fixtures/replay/parser-v2.mjs"),
        join(rightRoot, "parser.mjs"),
      ),
    ]);
    const authority = await permissionAuthorityForRoot(
      root,
      ["investigation_input"],
      ["investigation_input"],
    );
    const [left, right] = await Promise.all([
      analyzeJavaScriptApplication(authority, {
        input_path: leftRoot,
        approved: true,
      }),
      analyzeJavaScriptApplication(authority, {
        input_path: rightRoot,
        approved: true,
      }),
    ]);
    if (!left.ok) throw left.error;
    if (!right.ok) throw right.error;
    const bundlePath = join(root, "evidence.json");
    await writeFile(
      bundlePath,
      serializeEvidenceBundle(createEvidenceBundle([left.value, right.value])),
    );
    const compared = await runCli(
      [
        "compare-javascript-export-shapes",
        JSON.stringify({
          left_evidence_id: left.value.evidence_id,
          right_evidence_id: right.value.evidence_id,
          left_module_path: "parser.mjs",
          left_export_name: "default",
          right_module_path: "parser.mjs",
          right_export_name: "default",
        }),
        "--evidence-bundle",
        bundlePath,
        "--json",
      ],
      { REA_EVIDENCE_ROOTS_JSON: JSON.stringify([root]) },
    );
    expect(compared).toMatchObject({
      operation: "compare_javascript_export_shapes",
      predicate_type: "rea.javascript-export-shape-comparison/v1",
      normalized_result: {
        summary: { added: 1, removed: 0, changed: 0, unknown: 0 },
        changes: [
          {
            status: "added",
            path: "/depth",
            right: { availability: "literal", value: 1 },
          },
        ],
      },
    });
  }, 20_000);

  it("returns safe actionable JSON validation details", async () => {
    const malformed = await runCli([
      "trace-application-feature",
      "{not-json",
      "--json",
    ]);
    expect(malformed).toMatchObject({
      code: "invalid_request",
      retryable: true,
      details: {
        issues: [{ path: [], reason: "invalid_format", expected: "JSON" }],
      },
    });
    expect(JSON.stringify(malformed)).not.toContain("not-json");

    const missing = await runCli(["trace-application-feature", "{}", "--json"]);
    expect(missing).toMatchObject({
      code: "invalid_request",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["seed"],
            reason: "missing_argument",
          }),
        ]),
      },
    });
  }, 20_000);
});

const runCli = async (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<unknown> => {
  try {
    const { stdout } = await execute(
      process.execPath,
      ["scripts/rea.mjs", ...arguments_],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...environment },
        maxBuffer: 16 * 1_024 * 1_024,
      },
    );
    return JSON.parse(stdout);
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "stdout" in cause &&
      typeof cause.stdout === "string"
    )
      return JSON.parse(cause.stdout);
    throw cause;
  }
};
