import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { createHash } from "node:crypto";

import { expect } from "vitest";

import { environmentManifestHar } from "../../fixtures/historicalHar.js";
import {
  analysisViewCaptureEvidence,
  environmentManifestCaptureFixture,
} from "../../fixtures/analysisView.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { environmentBuildReportSchema } from "../../../src/domain/environmentBundleExport.js";
import { webNetworkCaptureSchema } from "../../../src/domain/webNetworkCapture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const RULES = [
  "after-uid-literal",
  "opaque-token",
  "sibling-variance",
  "prefix-variance",
];

cliTest.for(["different-content", "wrong-role", "matching"] as const)(
  "reports credential scan coverage for shipped HAR source bytes: %s",
  async (mode, { cli }) => {
    const root = await createTestTempDirectory("rea-environment-body-source-");
    const retained = Buffer.from('{"token":"retained-only-secret"}');
    const encoded = retained.toString("base64");
    const capture = environmentManifestCaptureFixture([
      {
        request: { method: "GET", url: "http://app.example/api/proof" },
        response: {
          status: 200,
          content: {
            mimeType: "application/json",
            encoding: "base64",
            text:
              mode === "different-content"
                ? Buffer.from('{"ok":true}').toString("base64")
                : ` \t${encoded}\n`,
          },
        },
      },
    ]);
    capture.records[0]!.binary_fields = [
      {
        pointer: "/response/content/text",
        representation:
          mode === "wrong-role" ? "producer-bytes" : "har-base64-content",
        state: "retained",
        content_base64: encoded,
        bytes: retained.length,
        sha256: createHash("sha256").update(retained).digest("hex"),
      },
    ];
    const input = JSON.stringify(analysisViewCaptureEvidence(capture));
    const path = join(root, "capture.json");
    const output = join(root, "bundle");
    await writeFile(path, input);
    const result = await cli.run({
      arguments: ["environment-build", path, output, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = environmentBuildReportSchema.parse(result.json);
    const shipped = webNetworkCaptureSchema.parse(
      parseEvidence(
        JSON.parse(
          await readFile(
            join(output, "envs", report.name, "evidence.json"),
            "utf8",
          ),
        ),
      ).normalized_result,
    );
    expect(shipped.records[0]!.binary_fields).toEqual(
      capture.records[0]!.binary_fields,
    );
    expect(shipped.records[0]!.reported).toEqual(capture.records[0]!.reported);
    expect(await readFile(path, "utf8")).toBe(input);
    const warnings = report.warnings.filter(({ code }) =>
      code.startsWith("credential-"),
    );
    expect(warnings).toEqual([
      expect.objectContaining({
        code:
          mode === "matching"
            ? "credential-named-members"
            : "credential-scan-incomplete",
        pointers: [
          mode === "matching"
            ? "record 0 response /token"
            : "record 0 response",
        ],
      }),
    ]);
    if (mode !== "matching") expect(warnings[0]?.message).toContain("source");
    expect(JSON.stringify(report)).not.toContain("retained-only-secret");
  },
);

const listFiles = async (root: string): Promise<string[]> =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(root.length + 1)
        .split(sep)
        .join("/"),
    )
    .sort();

cliTest(
  "attributes invalid capture JSON to the capture argument",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-environment-invalid-capture-",
    );
    const capture = join(root, "invalid.json");
    await writeFile(capture, "{");
    const result = await cli.run({
      arguments: ["environment-build", capture, join(root, "output"), "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["capture"], reason: "invalid_format" }] },
    });
  },
);

cliTest.for(["absolute", "relative"] as const)(
  "builds the bundle the three CLI steps build, byte for byte (%s capture path)",
  async (pathKind, { cli }) => {
    const root = await createTestTempDirectory("rea-environment-build-cli-");
    const har = join(root, "grafana.har");
    const callerPath = pathKind === "relative" ? "./grafana.har" : har;
    await writeFile(har, JSON.stringify(environmentManifestHar()));
    const built = await cli.run({
      arguments: [
        "environment-build",
        callerPath,
        join(root, "built"),
        "--json",
      ],
      cwd: root,
    });
    expect(built.exitCode, built.stderr).toBe(0);
    expect(built.json).toMatchObject({
      status: "built",
      name: "grafana-example",
      capture: { input: "har", operation: "inspect_web_network_capture" },
      manifest: { template_rules: RULES },
      state: { served: true },
      warnings: [],
    });

    const inspected = await cli.run({
      arguments: [
        "inspect-web-network-capture",
        callerPath,
        "har",
        "--format",
        "json",
      ],
      cwd: root,
    });
    expect(inspected.exitCode, inspected.stderr).toBe(0);
    expect(inspected.json).toMatchObject({
      caller_input_path: callerPath,
      parameters: { capture_path: har },
    });
    const capture = join(root, "capture.json");
    await writeFile(capture, inspected.stdout);
    const request = join(root, "view.json");
    await writeFile(
      request,
      JSON.stringify({
        source: { kind: "evidence-file", path: capture },
        view: { kind: "environment-manifest", template_rules: RULES },
      }),
    );
    const projected = await cli.run({
      arguments: ["inspect-analysis-view", request, "--format", "json"],
    });
    expect(projected.exitCode, projected.stderr).toBe(0);
    const manifest = join(root, "manifest.json");
    await writeFile(manifest, projected.stdout);
    for (const command of [
      "environment-build",
      "environment-export",
    ] as const) {
      const parent = join(root, `${command}-refused`);
      await mkdir(parent);
      // Do not use join for the last segment: the caller's spelling matters.
      const destination = `${join(parent, "a", "b", "c")}${sep}..`;
      const args =
        command === "environment-build"
          ? [command, har, destination, "--json"]
          : [command, manifest, "--evidence", capture, destination, "--json"];
      const refused = await cli.run({ arguments: args });
      expect(refused.exitCode, refused.stderr).toBe(1);
      expect(refused.json).toMatchObject({
        code: "invalid_request",
        details: { issues: [{ path: ["directory"] }] },
      });
      expect(await readdir(parent)).toEqual([]);
    }
    const exported = await cli.run({
      arguments: [
        "environment-export",
        manifest,
        "--evidence",
        capture,
        join(root, "three-step"),
        "--json",
      ],
    });
    expect(exported.exitCode, exported.stderr).toBe(0);

    const files = await listFiles(join(root, "built"));
    expect(files).toEqual(await listFiles(join(root, "three-step")));
    expect(files).toHaveLength(7);
    for (const file of files)
      expect(
        Buffer.compare(
          await readFile(join(root, "built", file)),
          await readFile(join(root, "three-step", file)),
        ),
        file,
      ).toBe(0);
    const published = JSON.parse(
      await readFile(
        join(root, "built", "envs", "grafana-example", "evidence.json"),
        "utf8",
      ),
    ) as { caller_input_path?: string };
    expect(published.caller_input_path).toBe(callerPath);
    expect(built.json).toMatchObject({
      tool_count: (exported.json as { tool_count: number }).tool_count,
      files: (exported.json as { files: unknown[] }).files,
    });

    const coverageRequest = join(root, "coverage.json");
    await writeFile(
      coverageRequest,
      JSON.stringify({
        source: { kind: "evidence-file", path: capture },
        view: { kind: "environment-coverage", template_rules: RULES },
      }),
    );
    const coverage = await cli.run({
      arguments: ["inspect-analysis-view", coverageRequest, "--format", "json"],
    });
    expect(coverage.exitCode, coverage.stderr).toBe(0);
    const view = (
      coverage.json as {
        normalized_result: { kind: string; reads: unknown; writes: unknown };
      }
    ).normalized_result;
    const report = (
      built.json as { coverage: { reads: unknown; writes: unknown } }
    ).coverage;
    expect(view.kind).toBe("environment-coverage");
    expect(view.reads).toEqual(report.reads);
    expect(view.writes).toEqual(report.writes);
  },
);

cliTest(
  "plans without writing on a dry run and refuses unusable arguments",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-environment-build-plan-");
    const har = join(root, "grafana.har");
    await writeFile(har, JSON.stringify(environmentManifestHar()));
    const planned = await cli.run({
      arguments: [
        "environment-build",
        har,
        "--dry-run",
        "--capture-timeout-ms=030000",
        "--json",
      ],
    });
    expect(planned.exitCode, planned.stderr).toBe(0);
    expect(planned.json).toMatchObject({
      status: "planned",
      directory: null,
      next: [],
    });
    expect(await readdir(root)).toEqual(["grafana.har"]);

    const other = join(root, "grafana.saz");
    await writeFile(other, "not a capture");
    const unsupported = await cli.run({
      arguments: ["environment-build", other, join(root, "out"), "--json"],
    });
    expect(unsupported.exitCode).toBe(1);
    expect(unsupported.json).toMatchObject({
      code: "invalid_request",
      details: { operation: "environment-build" },
    });

    const conflicting = await cli.run({
      arguments: [
        "environment-build",
        har,
        join(root, "out"),
        "--format-rules-only",
        "--template-rule",
        "opaque-token",
        "--json",
      ],
    });
    expect(conflicting.exitCode).toBe(1);
    expect(conflicting.json).toMatchObject({ code: "invalid_request" });

    // Both capture readers share the field. Numeric coercion would read
    // "0x1" as a 1 ms capture deadline.
    for (const command of [
      ["environment-build", har, "--dry-run"],
      ["inspect-web-network-capture", har, "har"],
    ]) {
      const hexDeadline = await cli.run({
        arguments: [...command, "--capture-timeout-ms=0x1", "--json"],
      });
      expect(hexDeadline.exitCode).toBe(1);
      expect(hexDeadline.json).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: [expect.objectContaining({ path: "captureTimeoutMs" })],
      });
    }

    const noDirectory = await cli.run({
      arguments: ["environment-build", har, "--json"],
    });
    expect(noDirectory.exitCode).toBe(1);
    expect(noDirectory.json).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["directory"] }] },
    });
    const emptyWorkingDirectory = join(root, "empty-cwd");
    await mkdir(emptyWorkingDirectory);
    const emptyDirectory = await cli.run({
      arguments: ["environment-build", har, "", "--json"],
      cwd: emptyWorkingDirectory,
    });
    expect(emptyDirectory.exitCode).toBe(1);
    expect(await readdir(emptyWorkingDirectory)).toEqual([]);
    expect((await readdir(root)).sort()).toEqual([
      "empty-cwd",
      "grafana.har",
      "grafana.saz",
    ]);
  },
);

cliTest.for(["--dry-run=abc", "--dry-run="] as const)(
  "rejects malformed environment-build dry-run %s before publication",
  async (dryRun, { cli }) => {
    const root = await createTestTempDirectory(
      "rea-environment-invalid-dry-run-",
    );
    const har = join(root, "grafana.har");
    const output = join(root, "bundle");
    await writeFile(har, JSON.stringify(environmentManifestHar()));
    const result = await cli.run({
      arguments: ["environment-build", har, output, dryRun, "--json"],
    });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("--dry-run");
    expect(await readdir(root)).toEqual(["grafana.har"]);
  },
);

cliTest.for(["--dry-run=true", "--dry-run=false"] as const)(
  "preserves explicit environment-build dry-run value %s",
  async (dryRun, { cli }) => {
    const root = await createTestTempDirectory(
      "rea-environment-explicit-dry-run-",
    );
    const har = join(root, "grafana.har");
    const output = join(root, "bundle");
    await writeFile(har, JSON.stringify(environmentManifestHar()));
    const result = await cli.run({
      arguments: ["environment-build", har, output, dryRun, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      status: dryRun === "--dry-run=true" ? "planned" : "built",
    });
    expect((await readdir(root)).includes("bundle")).toBe(
      dryRun === "--dry-run=false",
    );
  },
);

cliTest(
  "reports its default build-stage logging through the routed CLI driver",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-environment-build-logs-");
    const har = join(root, "grafana.har");
    await writeFile(har, JSON.stringify(environmentManifestHar()));
    // Without REA_LOG_LEVEL the build logs its stages at info on stderr.
    const invocation = {
      arguments: ["environment-build", har, "--dry-run", "--json"],
    };
    const routed = await cli.run(invocation);
    const fresh = await cli.run({ ...invocation, freshProcess: true });
    expect(fresh.stderr).toContain("Building environment");
    const stages = (stderr: string) =>
      stderr
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as { stage?: unknown }).stage);
    expect(stages(routed.stderr)).toEqual(stages(fresh.stderr));
    expect(routed.exitCode).toBe(fresh.exitCode);
  },
);
