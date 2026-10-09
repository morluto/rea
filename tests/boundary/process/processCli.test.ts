import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  captureProcessScenarioFile,
  compareProcessEvidenceFiles,
  projectProcessCliError,
} from "../../../src/application/process/ProcessCli.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { ProcessCaptureError } from "../../../src/process/capture/ProcessCaptureError.js";
import { PROCESS_PROVIDER } from "../../../src/application/process/ProcessEvidence.js";
import { INVESTIGATION_EXAMPLES } from "../../../src/contracts/investigationExamples.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const CLI_INTEGRATION_TIMEOUT_MS = 60_000;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fixture = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-process-cli-");
  roots.push(root);
  return root;
};

describe("documented process CLI workflow", () => {
  it(
    "feeds the documented JSON capture into the comparison CLI",
    async () => {
      const root = await fixture();
      const guide = await readFile(
        new URL("../../../docs/process-capture.md", import.meta.url),
        "utf8",
      );
      const recipe = /```sh\nrea capture-process ([^\n]+)\n```/u.exec(
        guide,
      )?.[1];
      if (recipe === undefined)
        throw new Error("Missing process capture recipe");
      const [argumentsText, output] = recipe.split(" > ");
      if (argumentsText === undefined || output === undefined)
        throw new Error("Missing process capture redirection");
      const args = argumentsText.split(/\s+/u);
      const input = args[0];
      if (input === undefined) throw new Error("Missing scenario path");
      await writeFile(
        join(root, input),
        JSON.stringify({
          executable: process.execPath,
          arguments: ["-e", "process.stdout.write('documented-capture')"],
        }),
      );
      const cli = fileURLToPath(
        new URL("../../../scripts/rea.mjs", import.meta.url),
      );
      const capture = await execFileAsync(
        process.execPath,
        [cli, "capture-process", ...args],
        { cwd: root },
      );
      expect(JSON.parse(capture.stdout)).toMatchObject({
        operation: "capture_process_scenario",
      });
      await writeFile(join(root, output), capture.stdout);
      const comparison = await execFileAsync(
        process.execPath,
        [cli, "compare-process-captures", output, output, "--json"],
        { cwd: root },
      );
      expect(JSON.parse(comparison.stdout)).toMatchObject({
        operation: "compare_process_captures",
      });
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );
});

describe("process CLI errors", () => {
  it(
    "exits unsuccessfully without writing failure-shaped evidence",
    async () => {
      await expect(
        execFileAsync(
          process.execPath,
          ["scripts/rea.mjs", "capture-process", "/missing/scenario.json"],
          { cwd: process.cwd() },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining("category: invalid_input"),
      });
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );

  it("rejects NUL arguments before process launch", async () => {
    const root = await fixture();
    const scenario = join(root, "nul-argument.json");
    await writeFile(
      scenario,
      JSON.stringify({ executable: process.execPath, arguments: ["\0"] }),
    );

    expect(await captureProcessScenarioFile(scenario)).toMatchObject({
      error: "Process command failed",
      code: "invalid_request",
      category: "invalid_input",
      details: {
        operation: "capture_process_scenario",
        issues: [
          {
            path: ["arguments", 0],
            reason: "invalid_format",
            expected: "regex",
            message:
              "Values passed to operating-system APIs cannot contain NUL",
          },
        ],
      },
    });
  });
});

describe("process CLI environment key diagnostics", () => {
  it("reports the reserved process environment key constraint", async () => {
    const root = await fixture();
    const scenario = join(root, "reserved-environment.json");
    await writeFile(
      scenario,
      JSON.stringify({
        executable: process.execPath,
        environment: { REA_PROCESS_RUN_ID: "caller-value" },
      }),
    );

    expect(await captureProcessScenarioFile(scenario)).toMatchObject({
      error: "Process command failed",
      code: "invalid_request",
      category: "invalid_input",
      details: {
        operation: "capture_process_scenario",
        issues: [
          {
            path: ["environment", "REA_PROCESS_RUN_ID"],
            reason: "invalid_format",
            expected: "regex",
            message: "REA_PROCESS_RUN_ID is reserved by the process adapter",
          },
        ],
      },
    });
  });
});

describe("process CLI evidence validation", () => {
  it("preserves sanitized unknown-process IDs and reasons through CLI projection", () => {
    const reason =
      "process ownership token could not be read for 1 live process(es): environment_unavailable=1; live candidates 900=environment_unavailable";
    const projected = projectProcessCliError(
      new ProcessCaptureError("cleanup incomplete", {
        reason: "cleanup_incomplete",
        cleanupResources: ["owned_process_group"],
        cleanupReport: {
          owned_process_group: { state: "unverified", reason },
          terminal_renderer: { state: "cleaned", reason: null },
          temporary_root: { state: "cleaned", reason: null },
        },
      }),
    );
    expect(projected).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        cleanup_report: {
          owned_process_group: { reason },
        },
      },
    });
  });

  it("captures the minimal executable-and-arguments scenario", async () => {
    const root = await fixture();
    const scenario = join(root, "scenario.json");
    await writeFile(
      scenario,
      JSON.stringify({
        executable: process.execPath,
        arguments: ["-e", "process.stdout.write('minimal-capture')"],
      }),
    );
    const evidence = await captureProcessScenarioFile(scenario);
    expect(evidence).toMatchObject({
      predicate_type: "rea.process-capture",
      operation: "capture_process_scenario",
    });
    expect(JSON.stringify(evidence)).toContain("minimal-capture");
  });

  it("rejects unrelated capture evidence", async () => {
    const root = await fixture();
    const invalidCapture = join(root, "invalid-capture.json");
    const unrelated = join(root, "unrelated.json");
    await writeFile(
      invalidCapture,
      JSON.stringify(
        createEvidence(undefined, PROCESS_PROVIDER, {
          predicateType: "rea.process-capture/other",
          operation: "capture_process_scenario",
          parameters: {},
          result: {},
        }),
      ),
    );
    await writeFile(
      unrelated,
      JSON.stringify(
        createEvidence(undefined, PROCESS_PROVIDER, {
          predicateType: "unrelated/v1",
          operation: "other",
          parameters: {},
          result: {},
        }),
      ),
    );

    expect(
      await compareProcessEvidenceFiles(invalidCapture, invalidCapture),
    ).toMatchObject({
      error: "Process command failed",
      category: "invalid_input",
    });
    expect(await compareProcessEvidenceFiles(unrelated, unrelated)).toEqual({
      error: "Process command failed",
      category: "invalid_input",
      message:
        "Capture evidence is not from the current process-capture workflow. Create new capture evidence, then try again.",
    });
  });

  it("classifies malformed capture evidence as invalid input", async () => {
    const root = await fixture();
    const malformed = join(root, "malformed-evidence.json");
    await writeFile(malformed, "{}");

    expect(
      await compareProcessEvidenceFiles(malformed, malformed),
    ).toMatchObject({
      error: "Process command failed",
      category: "invalid_input",
      code: "invalid_request",
      details: {
        operation: "compare_process_captures",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["parameters"],
            reason: "missing_argument",
          }),
        ]),
      },
    });
  });
});

it(
  "reports the JSON depth constraint through the compiled comparison CLI",
  async () => {
    const root = await fixture();
    const left = join(root, "left.json");
    const right = join(root, "right.json");
    const input = INVESTIGATION_EXAMPLES.compare_process_captures.input;
    await writeFile(left, JSON.stringify(input.left));
    await writeFile(right, JSON.stringify(input.right));
    const cli = fileURLToPath(
      new URL("../../../scripts/rea.mjs", import.meta.url),
    );
    const cliArguments = [
      cli,
      "compare-process-captures",
      left,
      right,
      "--json",
    ];
    const baseline = await execFileAsync(process.execPath, cliArguments);
    expect(JSON.parse(baseline.stdout)).toMatchObject({
      operation: "compare_process_captures",
    });
    const nested = '{"nested":'.repeat(10_000) + "1" + "}".repeat(10_000);
    await writeFile(
      left,
      JSON.stringify({
        ...input.left,
        parameters: { attack: "depth-placeholder" },
      }).replace('"depth-placeholder"', nested),
    );
    await expect(
      execFileAsync(process.execPath, cliArguments),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("maximum nesting depth"),
    });
  },
  CLI_INTEGRATION_TIMEOUT_MS,
);
