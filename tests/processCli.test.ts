import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureProcessScenarioFile,
  compareProcessEvidenceFiles,
  projectProcessCliError,
} from "../src/application/ProcessCli.js";
import { createEvidence } from "../src/domain/evidence.js";
import { PROCESS_PROVIDER } from "../src/application/ProcessEvidence.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const CLI_INTEGRATION_TIMEOUT_MS = 60_000;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-process-cli-"));
  roots.push(root);
  return root;
};

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
      category: "invalid_input",
      message:
        "Process scenario is invalid. Check its required fields and limits, then try again.",
    });
  });

  it("reports the exact process-capture policy recovery", async () => {
    const root = await fixture();
    const scenario = join(root, "scenario.json");
    await writeFile(
      scenario,
      JSON.stringify({
        approved: true,
        executable: "/bin/sh",
        working_directory: "/tmp",
      }),
    );
    expect(await captureProcessScenarioFile(scenario)).toMatchObject({
      error: "Process command failed",
      code: "permission_required",
      category: "permission_required",
      message:
        "This operation needs additional local permission. Review the requested scope and remediation.",
      details: {
        capability: "process_capture",
        ceiling: null,
      },
      remediation: {
        restart_required: false,
        elicitation_supported: false,
      },
    });
  });

  it("rejects oversized process input before parsing", async () => {
    const root = await fixture();
    const path = join(root, "large.json");
    const handle = await open(path, "w");
    await handle.truncate(64 * 1024 * 1024 + 1);
    await handle.close();
    expect(await captureProcessScenarioFile(path)).toEqual({
      error: "Process command failed",
      category: "truncated",
      message:
        "Process input file is too large. Reduce it below 64 MiB, then try again.",
    });
  });

  it("explains unsupported and unrelated capture evidence", async () => {
    const root = await fixture();
    const legacy = join(root, "legacy.json");
    const unrelated = join(root, "unrelated.json");
    await writeFile(
      legacy,
      JSON.stringify(
        createEvidence(undefined, PROCESS_PROVIDER, {
          predicateType: "rea.process-capture/v3",
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

    const legacyResult = await compareProcessEvidenceFiles(legacy, legacy);
    expect(legacyResult).toMatchObject({
      error: "Process command failed",
      category: "invalid_input",
    });
    expect(JSON.stringify(legacyResult)).toContain(
      "Process Capture v3 is unsupported",
    );
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
