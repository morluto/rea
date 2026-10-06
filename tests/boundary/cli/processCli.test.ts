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
} from "../../../src/application/ProcessCli.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { PROCESS_PROVIDER } from "../../../src/application/ProcessEvidence.js";

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

  it("projects unexpected causes without their message or stack", () => {
    const projected = projectProcessCliError(
      new Error("SECRET internal failure /private/path"),
    );
    expect(projected).toEqual({
      error: "Process command failed",
      category: "execution_failure",
      message:
        "Process command could not complete. Check the input files and run `rea doctor`, then try again.",
    });
    expect(JSON.stringify(projected)).not.toContain("SECRET");
  });

  it("projects missing, malformed JSON, and invalid scenario files", async () => {
    const root = await fixture();
    const malformed = join(root, "malformed.json");
    const invalid = join(root, "invalid.json");
    await writeFile(malformed, "not-json");
    await writeFile(invalid, "{}");

    expect(
      await captureProcessScenarioFile(join(root, "missing.json")),
    ).toEqual({
      error: "Process command failed",
      category: "invalid_input",
      message:
        "Process input file could not be read. Check that the path exists and is readable.",
    });
    expect(await captureProcessScenarioFile(malformed)).toEqual({
      error: "Process command failed",
      category: "invalid_input",
      message:
        "Process input file is not valid JSON. Repair the file, then try again.",
    });
    expect(await captureProcessScenarioFile(invalid)).toEqual({
      error: "Process command failed",
      code: "invalid_request",
      category: "invalid_input",
      message: "Analysis input is invalid. Check the arguments and try again.",
      retryable: true,
      remediation: { action: "Correct the listed arguments and retry." },
      details: expect.objectContaining({
        operation: "capture_process_scenario",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["executable"] }),
        ]),
      }),
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

    expect(await compareProcessEvidenceFiles(malformed, malformed)).toEqual({
      error: "Process command failed",
      category: "invalid_input",
      message:
        "Capture evidence is malformed. Create new capture evidence, then try again.",
    });
  });
});
