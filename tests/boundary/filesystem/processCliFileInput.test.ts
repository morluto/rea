import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  captureProcessScenarioFile,
  compareProcessEvidenceFiles,
  projectProcessCliError,
} from "../../../src/application/process/ProcessCli.js";
import { JSON_BYTE_ORDER_MARK_MESSAGE } from "../../../src/application/Utf8JsonInput.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { PROCESS_PROVIDER } from "../../../src/domain/process/processEvidenceProvider.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../../../src/domain/process/processCaptureExample.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { RegularFileCleanupFailure } from "../../../src/application/RegularFileRead.js";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { holdFirstFileRead } from "../../support/holdFirstFileRead.js";

describe("process CLI error projection", () => {
  it("preserves local diagnostics for unexpected process failures", () => {
    const projected = projectProcessCliError(
      new Error("SECRET internal failure /private/path"),
    );
    expect(projected).toEqual({
      error: "Process command failed",
      category: "execution_failure",
      message:
        "Process command could not complete: SECRET internal failure /private/path",
    });
    expect(JSON.stringify(projected)).not.toContain("stack");
  });
});

describe("process CLI file cancellation", () => {
  it("projects pre-aborted file reads as cancellation", async () => {
    const root = await createTestTempDirectory("rea-process-cli-cancel-");
    const controller = new AbortController();
    controller.abort();
    expect(
      await captureProcessScenarioFile(
        join(root, "missing-scenario.json"),
        process.env,
        controller.signal,
      ),
    ).toMatchObject({
      error: "Process command failed",
      code: "cancelled",
      category: "cancelled",
      details: { operation: "capture_process_scenario" },
    });
    expect(
      await compareProcessEvidenceFiles(
        join(root, "missing-left.json"),
        join(root, "missing-right.json"),
        join(root, "missing-trace.json"),
        controller.signal,
      ),
    ).toMatchObject({
      code: "cancelled",
      category: "cancelled",
      details: { operation: "compare_process_captures" },
    });
  });

  it.each([
    { workflow: "capture", input: "scenario" },
    { workflow: "compare", input: "left" },
    { workflow: "compare", input: "right" },
    { workflow: "compare", input: "trace specification" },
  ] as const)(
    "stops streamed $workflow $input reads after cancellation",
    async ({ workflow, input }) => {
      const root = await createTestTempDirectory("rea-process-cli-stream-");
      const paths = {
        scenario: join(root, "scenario.json"),
        left: join(root, "left.json"),
        right: join(root, "right.json"),
        trace: join(root, "trace.json"),
      };
      const evidence = JSON.stringify(processCaptureEvidence());
      const scenario = JSON.stringify({
        executable: process.execPath,
        arguments: [],
      });
      const traceSpecification = JSON.stringify(validTraceSpecification());
      const contentsByInput = {
        scenario: input === "scenario" ? stream(scenario) : scenario,
        left: input === "left" ? stream(evidence) : evidence,
        right: input === "right" ? stream(evidence) : evidence,
        trace:
          input === "trace specification"
            ? stream(traceSpecification)
            : traceSpecification,
      };
      await Promise.all([
        writeFile(paths.scenario, contentsByInput.scenario),
        writeFile(paths.left, contentsByInput.left),
        writeFile(paths.right, contentsByInput.right),
        writeFile(paths.trace, contentsByInput.trace),
      ]);
      const targetPath =
        paths[input === "trace specification" ? "trace" : input];
      const contents =
        contentsByInput[input === "trace specification" ? "trace" : input];
      const reader = await holdFirstFileRead(targetPath);
      onTestFinished(reader.release);
      const controller = new AbortController();
      try {
        const pending =
          workflow === "capture"
            ? captureProcessScenarioFile(
                paths.scenario,
                process.env,
                controller.signal,
              )
            : compareProcessEvidenceFiles(
                paths.left,
                paths.right,
                paths.trace,
                controller.signal,
              );
        await reader.firstRead;
        controller.abort();
        reader.release();
        expect(await pending).toMatchObject({
          error: "Process command failed",
          code: "cancelled",
          category: "cancelled",
        });
        expect(reader.readCount).toBe(1);
        expect(reader.totalReadBytes).toBeLessThan(contents.length);
      } finally {
        controller.abort();
        reader.release();
        vi.restoreAllMocks();
      }
    },
  );
});

describe("process CLI input diagnostics", () => {
  it("projects missing, malformed JSON, and invalid scenario files", async () => {
    const root = await createTestTempDirectory("rea-process-cli-diagnostics-");
    const malformed = join(root, "malformed.json");
    const invalid = join(root, "invalid.json");
    const invalidUtf8 = join(root, "invalid-utf8.json");
    await writeFile(malformed, "not-json");
    await writeFile(invalid, "{}");
    await writeFile(
      invalidUtf8,
      Buffer.concat([
        Buffer.from('{"executable":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ]),
    );

    expect(
      await captureProcessScenarioFile(join(root, "missing.json")),
    ).toEqual({
      error: "Process command failed",
      category: "invalid_input",
      message: expect.stringContaining(
        `Process input file could not be read: ${join(root, "missing.json")} (ENOENT`,
      ),
    });
    expect(await captureProcessScenarioFile(malformed)).toEqual({
      error: "Process command failed",
      category: "invalid_input",
      message: expect.stringContaining(
        `Process input file is not valid UTF-8 JSON: ${malformed}`,
      ),
    });
    expect(await captureProcessScenarioFile(invalidUtf8)).toEqual({
      error: "Process command failed",
      category: "invalid_input",
      message: expect.stringContaining(
        `Process input file is not valid UTF-8 JSON: ${invalidUtf8}`,
      ),
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

  it.each([false, true])(
    "preserves the open-file owner when close fails (cancelled: %s)",
    async (cancelDuringClose) => {
      const root = await createTestTempDirectory("rea-process-cli-cleanup-");
      const path = join(root, "scenario.json");
      await writeFile(path, JSON.stringify({ executable: process.execPath }));
      const controller = new AbortController();
      const cleanupCause = new Error("injected file close failure");
      const close = vi
        .spyOn(OwnedFileHandle.prototype, "close")
        .mockImplementationOnce(async () => {
          if (cancelDuringClose) controller.abort();
          throw cleanupCause;
        });
      let failure: unknown;
      try {
        try {
          await captureProcessScenarioFile(
            path,
            process.env,
            cancelDuringClose ? controller.signal : undefined,
          );
        } catch (cause: unknown) {
          failure = cause;
        }
        expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
        if (!(failure instanceof RegularFileCleanupFailure))
          throw new Error("Expected the retained file handle owner");
        expect(failure.cleanupCause).toBe(cleanupCause);
        expect(failure.owner.handle.fd).toBeGreaterThanOrEqual(0);
      } finally {
        close.mockRestore();
        if (failure instanceof RegularFileCleanupFailure)
          await failure.owner.close();
      }
    },
  );

  it("names a leading byte-order mark instead of quoting it as a token", async () => {
    const path = join(
      await createTestTempDirectory("rea-process-cli-diagnostics-"),
      "scenario.json",
    );
    await writeFile(path, '\uFEFF{"executable":"/bin/echo"}');
    expect(await captureProcessScenarioFile(path)).toEqual({
      error: "Process command failed",
      category: "invalid_input",
      message: `Process input file is not valid UTF-8 JSON: ${path} (${JSON_BYTE_ORDER_MARK_MESSAGE}). Repair the file, then try again.`,
    });
  });
});

const processCaptureEvidence = () =>
  createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-capture",
    operation: "capture_process_scenario",
    parameters: {},
    result: EMPTY_PROCESS_CAPTURE_EXAMPLE,
    confidence: "observed",
    authority: "controlled-replay",
    environment: {
      id: "fixture",
      platform: "fixture",
      architecture: "fixture",
      isolation: "process",
    },
  });

const stream = (json: string) => " ".repeat(8 * 1024 * 1024) + json;

const validTraceSpecification = () => ({
  events: [
    {
      id: "started",
      source: "lifecycle",
      exact: { state: "started" },
    },
    {
      id: "finished",
      source: "lifecycle",
      exact: { state: "finished" },
    },
  ],
  language: {
    kind: "partial_order",
    happens_before: [{ before: "started", after: "finished" }],
  },
});
