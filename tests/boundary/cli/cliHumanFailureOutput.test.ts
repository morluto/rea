import { captureOutput } from "../../support/cli/capturedOutput.js";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { parseCliOutputArguments } from "../../../src/cli/cliOutput.js";
import { createCliResultOutput } from "../../../src/cli/cliResultOutput.js";
import { registerCliCommand } from "../../../src/cli/commandRegistry.js";
import { logCliCommand } from "../../../src/cliLogging.js";
import {
  AnalysisInputError,
  unsupportedTarget,
} from "../../../src/domain/analysisErrorCore.js";
import {
  projectAnalysisError,
  type AnalysisErrorProjection,
} from "../../../src/domain/analysisErrorProjection.js";
import { BinaryTargetError } from "../../../src/domain/configurationErrors.js";
import { silentLogger } from "../../../src/logger.js";
import { createCommandCli } from "../../support/cli/commandCli.js";

const CLI_ISSUE_REPORT_URL = "https://github.com/morluto/rea/issues";

const unsupportedTargetProjection = (): AnalysisErrorProjection =>
  projectAnalysisError(
    unsupportedTarget(
      "inspect-target",
      "/tmp/sample.bin",
      "fixture",
      "Container format is unsupported.",
    ),
    "invocation",
  );

const targetUnavailableProjection = (): AnalysisErrorProjection =>
  projectAnalysisError(
    new BinaryTargetError("/tmp/missing.bin", "missing", {
      remediationAction: "Verify the target path exists and is readable.",
    }),
    "invocation",
  );

const fileFormatRejectedProjection = (): AnalysisErrorProjection => ({
  code: "invalid_request",
  category: "invalid_input",
  message: "The target format was rejected by the loader.",
  retryable: false,
  remediation: {
    action: "Check the file header and retry with a supported artifact.",
  },
  details: {
    path: "/tmp/unknown.bin",
    reason: "file_format_rejected",
  },
});

const executionFailureProjection = (): AnalysisErrorProjection => ({
  code: "execution_failure",
  category: "execution_failure",
  message: "The analysis backend failed unexpectedly.",
  retryable: false,
  remediation: {
    action: "Retry with --format json for full diagnostics.",
  },
});

const ordinaryInputProjection = (): AnalysisErrorProjection =>
  projectAnalysisError(
    new AnalysisInputError("inspect-target", {
      userMessage: "The --limit option must be a positive integer.",
      remediationAction: "Pass a positive integer for --limit.",
    }),
    "invocation",
  );

describe("CLI human-TTY failure rendering", () => {
  it("renders concise human text with CLI-only issue hint for unsupported_target on a TTY", async () => {
    const projection = unsupportedTargetProjection();
    expect(projection.code).toBe("unsupported_target");

    const { destination, text } = captureOutput(true);
    const output = createCliResultOutput(
      parseCliOutputArguments(["inspect-target"]),
      destination,
    );
    if (output === undefined) throw new Error("Missing CLI result output");

    const cli = createCommandCli(output);
    registerCliCommand(cli, "inspect-target", {
      args: z.object({}),
      run: () =>
        logCliCommand(silentLogger, "inspect-target", async () => projection),
    });

    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      await cli.serve(["inspect-target"]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }

    expect(output.handled).toBe(true);
    expect(output.failed).toBe(false);
    const rendered = text();
    expect(rendered).toContain(
      `Error (${projection.code}): ${projection.message}`,
    );
    expect(rendered).toContain(`Next step: ${projection.remediation.action}`);
    expect(rendered).toContain(CLI_ISSUE_REPORT_URL);
    expect(rendered).not.toContain("retryable:");
    expect(rendered).not.toContain("category:");
    expect(rendered.endsWith("\n")).toBe(true);
  });

  it.each([
    { name: "target_unavailable", projection: targetUnavailableProjection },
    {
      name: "details.reason === file_format_rejected",
      projection: fileFormatRejectedProjection,
    },
    { name: "execution_failure", projection: executionFailureProjection },
  ])(
    "appends the CLI-only issue hint in TTY human mode for $name",
    async ({ projection: build }) => {
      const projection = build();
      const { destination, text } = captureOutput(true);
      const output = createCliResultOutput(
        parseCliOutputArguments(["inspect-target"]),
        destination,
      );
      if (output === undefined) throw new Error("Missing CLI result output");

      expect(
        await output.write(projection, {
          command: "inspect-target",
          duration: "2ms",
        }),
      ).toBe(true);
      expect(output.handled).toBe(true);
      expect(output.failed).toBe(false);
      const rendered = text();
      expect(rendered).toContain(
        `Error (${projection.code}): ${projection.message}`,
      );
      expect(rendered).toContain(`Next step: ${projection.remediation.action}`);
      expect(rendered).toContain(CLI_ISSUE_REPORT_URL);
    },
  );

  it("omits the GitHub issue URL for ordinary expected input errors in TTY human mode", async () => {
    const projection = ordinaryInputProjection();
    expect(projection.code).toBe("invalid_request");

    const { destination, text } = captureOutput(true);
    const output = createCliResultOutput(
      parseCliOutputArguments(["inspect-target"]),
      destination,
    );
    if (output === undefined) throw new Error("Missing CLI result output");

    expect(
      await output.write(projection, {
        command: "inspect-target",
        duration: "1ms",
      }),
    ).toBe(true);
    const rendered = text();
    expect(rendered).toContain(
      `Error (${projection.code}): ${projection.message}`,
    );
    expect(rendered).toContain(`Next step: ${projection.remediation.action}`);
    expect(rendered).not.toContain(CLI_ISSUE_REPORT_URL);
    expect(rendered).not.toContain("retryable:");
  });

  it("keeps piped (non-TTY) stdout as machine-readable TOON without human prose or issue URL", async () => {
    const projection = unsupportedTargetProjection();
    const { destination, text } = captureOutput(false);
    const output = createCliResultOutput(
      parseCliOutputArguments(["inspect-target"]),
      destination,
    );
    if (output === undefined) throw new Error("Missing CLI result output");

    expect(
      await output.write(projection, {
        command: "inspect-target",
        duration: "1ms",
      }),
    ).toBe(true);
    const rendered = text();
    expect(rendered).toContain("code: unsupported_target");
    expect(rendered).toContain("category: unsupported_target");
    expect(rendered).not.toContain("Error (unsupported_target):");
    expect(rendered).not.toContain(CLI_ISSUE_REPORT_URL);
  });

  it.each([
    { name: "--json", args: ["--json"] },
    { name: "--format json", args: ["--format", "json"] },
    { name: "--format yaml", args: ["--format", "yaml"] },
    { name: "--format toon", args: ["--format", "toon"] },
    { name: "--format jsonl", args: ["--format", "jsonl"] },
    { name: "--format md", args: ["--format", "md"] },
    {
      name: "--format csv",
      args: ["--format", "csv", "--filter-output", "rows", "--columns", "id"],
    },
    {
      name: "--format tsv",
      args: ["--format", "tsv", "--filter-output", "rows", "--columns", "id"],
    },
    { name: "--full-output", args: ["--full-output"] },
    { name: "--token-count", args: ["--token-count"] },
    { name: "--token-limit", args: ["--token-limit", "50"] },
    { name: "--token-offset", args: ["--token-offset", "0"] },
    { name: "--filter-output", args: ["--filter-output", "code"] },
  ])(
    "bypasses human rendering and emits no issue URL on a TTY when $name is passed",
    async ({ args }) => {
      const projection = unsupportedTargetProjection();
      const { destination, text } = captureOutput(true);
      const parsed = parseCliOutputArguments(["inspect-target", ...args]);
      expect(parsed.validation.ok).toBe(true);
      const output = createCliResultOutput(parsed, destination);
      if (output === undefined) throw new Error("Missing CLI result output");

      expect(
        await output.write(projection, {
          command: "inspect-target",
          duration: "1ms",
        }),
      ).toBe(true);
      expect(output.handled).toBe(true);
      expect(output.failed).toBe(false);

      const rendered = text();
      expect(rendered).not.toContain("Error (unsupported_target):");
      expect(rendered).not.toContain(CLI_ISSUE_REPORT_URL);

      if (parsed.format === "json") {
        expect(JSON.parse(rendered)).toMatchObject({
          code: "unsupported_target",
        });
      } else if (parsed.format === "yaml") {
        expect(parseYaml(rendered)).toMatchObject({
          code: "unsupported_target",
        });
      }
    },
  );

  it("retains handled and failed destination ownership when a TTY write fails", async () => {
    const cause = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    const destination = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        callback(cause);
      },
    });
    Object.defineProperty(destination, "isTTY", { value: true });

    const output = createCliResultOutput(
      parseCliOutputArguments(["inspect-target"]),
      destination,
    );
    if (output === undefined) throw new Error("Missing CLI result output");

    await expect(
      output.write(unsupportedTargetProjection(), {
        command: "inspect-target",
        duration: "1ms",
      }),
    ).rejects.toBe(cause);
    expect(output.handled).toBe(true);
    expect(output.failed).toBe(true);
  });

  it("does not misclassify an unhealthy completed report as an AnalysisErrorProjection on a TTY", async () => {
    const { destination, text } = captureOutput(true);
    const output = createCliResultOutput(
      parseCliOutputArguments(["doctor"]),
      destination,
    );
    if (output === undefined) throw new Error("Missing CLI result output");

    expect(
      await output.write(
        { healthy: false, summary: "missing provider" },
        { command: "doctor", duration: "1ms" },
      ),
    ).toBe(true);
    const rendered = text();
    expect(rendered).toContain("healthy: false");
    expect(rendered).not.toContain("Error (");
    expect(rendered).not.toContain(CLI_ISSUE_REPORT_URL);
  });

  it("re-evaluates the human presentation gate across begin() invocations", async () => {
    const projection = unsupportedTargetProjection();
    const { destination, text } = captureOutput(true);
    const output = createCliResultOutput(
      parseCliOutputArguments(["inspect-target", "--json"]),
      destination,
    );
    if (output === undefined) throw new Error("Missing CLI result output");

    output.begin(parseCliOutputArguments(["inspect-target"]));
    expect(
      await output.write(projection, {
        command: "inspect-target",
        duration: "1ms",
      }),
    ).toBe(true);
    expect(text()).toContain(CLI_ISSUE_REPORT_URL);
  });

  it.each([
    {
      name: "cancelled failure with details.partial_observation",
      projection: (): AnalysisErrorProjection => ({
        code: "cancelled",
        category: "cancelled",
        message: "JavaScript application analysis was cancelled.",
        retryable: true,
        remediation: {
          action:
            "Reuse partial_observation Evidence from this result or retry.",
        },
        details: {
          partial_observation: {
            operation: "analyze_javascript_application",
            parsed_sources: ["app.js"],
          },
        },
      }),
      expectedToken: "partial_observation:",
      expectedValue: "app.js",
    },
    {
      name: "failure with details.completed_observation",
      projection: (): AnalysisErrorProjection => ({
        code: "execution_failure",
        category: "execution_failure",
        message: "A follow-up step failed after source analysis completed.",
        retryable: false,
        remediation: {
          action: "Inspect completed_observation before retrying.",
        },
        details: {
          completed_observation: {
            operation: "inspect_target",
            digest: "sha256:abc123",
          },
        },
      }),
      expectedToken: "completed_observation:",
      expectedValue: "sha256:abc123",
    },
    {
      name: "failure with details.argument_observations",
      projection: (): AnalysisErrorProjection => ({
        code: "execution_failure",
        category: "execution_failure",
        message: "Comparison failed after reading the first argument.",
        retryable: false,
        remediation: {
          action: "Inspect argument_observations before retrying.",
        },
        details: {
          argument_observations: [
            { argument: "before", observation: { path: "/tmp/before.bin" } },
          ],
        },
      }),
      expectedToken: "argument_observations",
      expectedValue: "/tmp/before.bin",
    },
    {
      name: "failure with details.captured_output",
      projection: (): AnalysisErrorProjection => ({
        code: "execution_failure",
        category: "execution_failure",
        message: "The native backend exited with status 2.",
        retryable: false,
        remediation: {
          action: "Review captured_output for backend diagnostics.",
        },
        details: {
          captured_output: {
            stderr: "loader: unsupported relocation 0x42",
          },
        },
      }),
      expectedToken: "captured_output:",
      expectedValue: "unsupported relocation 0x42",
    },
    {
      name: "cleanup_incomplete failure with remaining resources",
      projection: (): AnalysisErrorProjection => ({
        code: "cleanup_incomplete",
        category: "execution_failure",
        message: "Temporary staging directory could not be removed.",
        retryable: false,
        remediation: {
          action: "Review the reported resources before retrying.",
        },
        details: {
          cleanup: "incomplete",
          resources: ["/tmp/rea-staging-42"],
        },
      }),
      expectedToken: "resources",
      expectedValue: "/tmp/rea-staging-42",
    },
    {
      name: "failure with published evidence_bundle receipt",
      projection: (): AnalysisErrorProjection => ({
        code: "execution_failure",
        category: "execution_failure",
        message: "Analysis stopped after publishing partial evidence.",
        retryable: false,
        remediation: {
          action: "Inspect the published evidence bundle.",
        },
        details: {
          diagnostics: {
            evidence_bundle: {
              path: "/tmp/partial-evidence.json",
              bytes: 512,
            },
          },
        },
      }),
      expectedToken: "evidence_bundle:",
      expectedValue: "/tmp/partial-evidence.json",
    },
    {
      name: "failure with secondary_failures carrying partial_observation",
      projection: (): AnalysisErrorProjection => ({
        code: "execution_failure",
        category: "execution_failure",
        message: "Multiple operations failed.",
        retryable: false,
        remediation: {
          action: "Inspect secondary_failures for retained partial results.",
        },
        details: {
          secondary_failures: [
            {
              code: "cancelled",
              category: "cancelled",
              message: "Secondary step cancelled.",
              retryable: true,
              remediation: { action: "Reuse partial_observation." },
              details: {
                partial_observation: { parsed_sources: ["worker.js"] },
              },
            },
          ],
        },
      }),
      expectedToken: "partial_observation:",
      expectedValue: "worker.js",
    },
  ])(
    "preserves complete structured output on a TTY for $name",
    async ({ projection: build, expectedToken, expectedValue }) => {
      const projection = build();
      const { destination, text } = captureOutput(true);
      const output = createCliResultOutput(
        parseCliOutputArguments(["analyze-javascript-application"]),
        destination,
      );
      if (output === undefined) throw new Error("Missing CLI result output");

      expect(
        await output.write(projection, {
          command: "analyze-javascript-application",
          duration: "12ms",
        }),
      ).toBe(true);
      expect(output.handled).toBe(true);
      expect(output.failed).toBe(false);

      const rendered = text();
      expect(rendered).toContain(`code: ${projection.code}`);
      expect(rendered).toContain(expectedToken);
      expect(rendered).toContain(expectedValue);
      expect(rendered).not.toContain(`Error (${projection.code}):`);
      expect(rendered).not.toContain(CLI_ISSUE_REPORT_URL);
    },
  );
});
