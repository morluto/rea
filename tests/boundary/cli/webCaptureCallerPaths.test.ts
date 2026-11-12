import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { deliverAnalysisEvidence } from "../../../src/application/EvidenceBundleCommands.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  protobufCaptureDescriptor,
  protobufHar,
} from "../../fixtures/protobufCapture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "retains selected capture paths without exposing declared sensitive values",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-capture-selected-");
    const cwd = join(root, "secret-parent");
    await mkdir(cwd);
    await writeFile(join(cwd, "capture.har"), protobufHar());
    await writeFile(join(cwd, "capture.pb"), protobufCaptureDescriptor());
    const args = [
      "inspect-web-network-capture",
      "./capture.har",
      "har",
      "--record",
      "0",
      "--protobuf-schema",
      "./capture.pb",
      "--protobuf-message",
      "capture.Message",
      "--json",
    ];
    const result = await cli.run({ cwd, arguments: args });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = parseEvidence(result.json);
    expect(evidence.caller_input_path).toBe("./capture.har");
    expect(evidence.caller_input_paths).toEqual({
      descriptor_set_path: "./capture.pb",
    });
    const parentExcluded = await cli.run({
      cwd,
      arguments: [...args, "--sensitive-value", "secret-parent"],
    });
    expect(parentExcluded.exitCode, parentExcluded.stderr).toBe(0);
    expect(JSON.stringify(parentExcluded.json)).not.toContain("secret-parent");
    expect(parseEvidence(parentExcluded.json).caller_input_path).toBe(
      "./capture.har",
    );
    const originalExcluded = await cli.run({
      cwd,
      arguments: [...args, "--sensitive-value", "capture.har"],
    });
    expect(originalExcluded.exitCode, originalExcluded.stderr).toBe(0);
    expect(JSON.stringify(originalExcluded.json)).not.toContain("capture.har");
    const safe = parseEvidence(originalExcluded.json);
    expect(safe.caller_input_path).toBeUndefined();
    expect(safe.caller_input_paths).toEqual({
      descriptor_set_path: "./capture.pb",
    });
    const summaryExcluded = await cli.run({
      cwd,
      arguments: [
        ...args,
        "--sensitive-value",
        "capture.har",
        "--detail",
        "summary",
        "--evidence_output",
        "./safe-evidence.json",
      ],
    });
    expect(summaryExcluded.exitCode, summaryExcluded.stderr).toBe(0);
    const summary = parseEvidence(
      (summaryExcluded.json as { summary: unknown }).summary,
    );
    expect(summary.caller_input_path).toBeUndefined();
    expect(summary.caller_input_paths).toEqual({
      descriptor_set_path: "./capture.pb",
    });
    expect(JSON.stringify(summaryExcluded.json)).not.toContain("capture.har");
    const applicationSummary = await deliverAnalysisEvidence(
      safe,
      join(cwd, "application-evidence.json"),
      "summary",
    );
    if (!applicationSummary.ok) throw applicationSummary.error;
    expect(applicationSummary.value.caller_input_path).toBeUndefined();
    expect(applicationSummary.value.caller_input_paths).toEqual({
      descriptor_set_path: "./capture.pb",
    });
    const descriptorExcluded = await cli.run({
      cwd,
      arguments: [...args, "--sensitive-value", "capture.pb"],
    });
    expect(descriptorExcluded.exitCode, descriptorExcluded.stderr).toBe(0);
    expect(JSON.stringify(descriptorExcluded.json)).not.toContain("capture.pb");
    const safeDescriptor = parseEvidence(descriptorExcluded.json);
    expect(safeDescriptor.caller_input_path).toBe("./capture.har");
    expect(safeDescriptor.caller_input_paths).toBeUndefined();
    const { client, call } = await connectLocalToolsMcp();
    try {
      const response = await call("inspect_web_network_capture", {
        capture_path: join(cwd, "capture.har"),
        format: "har",
        record_ordinals: [0],
        protobuf: {
          schema: {
            descriptor_set_path: join(cwd, "capture.pb"),
            message_type: "capture.Message",
          },
        },
        sensitive_values: ["secret-parent"],
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expect(JSON.stringify(response)).not.toContain("secret-parent");
      expect(
        parseEvidence(response.structuredContent).caller_input_path,
      ).toBeUndefined();
    } finally {
      await client.close();
    }
  },
);
