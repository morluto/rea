import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { captureProcessScenarioFile } from "../../../src/application/process/ProcessCli.js";
import { isCliOperationFailure } from "../../../src/cliLogging.js";
import { createDirectAnalysis } from "../../../src/composition/directAnalysis.js";
import { probeProcessCaptureCapability } from "../../../src/process/capture/ProcessCaptureCapability.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseProcessCapture } from "../../../src/domain/process/processCaptureParsing.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("the CLI takes its environment as an input", () => {
  it("preserves an object-like environment name through capture", async ({
    skip,
  }) => {
    const capability = await probeProcessCaptureCapability();
    if (!capability.available) {
      skip("Process capture is unavailable on this host");
      return;
    }

    const root = await createTestTempDirectory("rea-cli-env-proto-");
    const scenarioPath = join(root, "scenario.json");
    await writeFile(
      scenarioPath,
      JSON.stringify({
        executable: process.execPath,
        arguments: [
          "-e",
          "console.log('selected='+Object.hasOwn(process.env,'__proto__')+':'+process.env['__proto__']);console.log('control='+process.env.NORMAL_CAPTURE_KEY)",
        ],
        environment: {
          ["__proto__"]: "selected-value",
          NORMAL_CAPTURE_KEY: "control-value",
        },
        timeout_ms: 5_000,
      }),
    );

    const result = await captureProcessScenarioFile(scenarioPath, {});
    if (isCliOperationFailure(result))
      throw new Error(
        `Process capture returned an error: ${JSON.stringify(result)}`,
      );
    const evidence = parseEvidence(result);
    const capture = parseProcessCapture(evidence.normalized_result);
    expect(capture.frames.map(({ data }) => data).join("")).toContain(
      "selected=true:selected-value",
    );
    expect(capture.frames.map(({ data }) => data).join("")).toContain(
      "control=control-value",
    );
    expect(capture.manifest.scenario.environment).toEqual({
      ["__proto__"]: "selected-value",
      NORMAL_CAPTURE_KEY: "control-value",
    });
  });

  it("resolves from injected PATH and inherits injected env with scenario overrides", async ({
    skip,
  }) => {
    const capability = await probeProcessCaptureCapability();
    if (!capability.available) {
      skip("Process capture is unavailable on this host");
      return;
    }

    const root = await createTestTempDirectory("rea-cli-env-process-");
    const bin = join(root, "bin");
    const executable = join(bin, "rea-injected-process-probe");
    const scenarioPath = join(root, "scenario.json");
    await mkdir(bin);
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        'printf "%s|%s\\n" "$REA_CAPTURE_INJECTED_MARKER" "$REA_CAPTURE_SCENARIO_OVERRIDE"',
      ].join("\n"),
    );
    await chmod(executable, 0o755);
    await writeFile(
      scenarioPath,
      JSON.stringify({
        executable: "rea-injected-process-probe",
        working_directory: root,
        environment: { REA_CAPTURE_SCENARIO_OVERRIDE: "scenario-value" },
      }),
    );

    const result = await captureProcessScenarioFile(scenarioPath, {
      PATH: bin,
      REA_CAPTURE_INJECTED_MARKER: "injected-value",
      REA_CAPTURE_SCENARIO_OVERRIDE: "host-value",
    });
    if (isCliOperationFailure(result))
      throw new Error(
        `Process capture returned an error: ${JSON.stringify(result)}`,
      );
    const evidence = parseEvidence(result);
    const capture = parseProcessCapture(evidence.normalized_result);
    expect(capture.frames.map(({ data }) => data).join("")).toContain(
      "injected-value|scenario-value",
    );
  });

  it("reports session status from a supplied environment", async () => {
    // An invalid configuration must surface through the caller's supplied
    // environment rather than whatever the process happens to carry.
    const result = await createDirectAnalysis({
      REA_LOG_LEVEL: "not-a-level",
    }).runSessionStatus();
    expect(result).toMatchObject({ error: expect.anything() });
  });
});
