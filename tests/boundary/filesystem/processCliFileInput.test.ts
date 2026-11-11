import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  captureProcessScenarioFile,
  compareProcessEvidenceFiles,
} from "../../../src/application/process/ProcessCli.js";
import * as scenarioPreparation from "../../../src/application/process/ProcessScenarioPreparation.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { PROCESS_PROVIDER } from "../../../src/domain/process/processEvidenceProvider.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../../../src/domain/process/processCaptureExample.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import {
  analysisCliErrorEnvelopeSchema,
  analysisErrorProjectionSchema,
} from "../../../src/contracts/errorSchemas.js";
import { EvidenceFileError } from "../../../src/domain/evidenceErrors.js";
import { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { err } from "../../../src/domain/result.js";
import * as jsonFiles from "../../../src/application/JsonFiles.js";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { holdFirstFileRead } from "../../support/holdFirstFileRead.js";
import { failFileReadAfterAbort } from "../../support/failFileReadAfterAbort.js";
import { JsonInputPhysicalReadFailure } from "../../../src/application/JsonInputFile.js";

describe("process CLI error projection", () => {
  it.each([
    {
      operation: "capture_process_scenario",
      execute: (path: string) => captureProcessScenarioFile(path),
    },
    {
      operation: "compare_process_captures",
      execute: (path: string) => compareProcessEvidenceFiles(path, path),
    },
  ] as const)(
    "projects an unexpected $operation failure canonically",
    async ({ operation, execute }) => {
      const failure = new Error("SECRET internal failure /private/path");
      const read = vi
        .spyOn(jsonFiles, "readJsonFile")
        .mockImplementation(async () => {
          throw failure;
        });

      try {
        const projected = await execute("/selected/input.json");
        expect(
          analysisCliErrorEnvelopeSchema.safeParse(projected).success,
        ).toBe(true);
        expect(projected).toMatchObject({
          error: "Process command failed",
          code: "execution_failure",
          category: "execution_failure",
          retryable: false,
          message:
            "Process command could not complete: SECRET internal failure /private/path",
          remediation: {
            action: expect.stringMatching(
              /do not repeat.*input files.*rea doctor/iu,
            ),
          },
          details: {
            operation,
            provider_id: PROCESS_PROVIDER.id,
            diagnostics: { phase: "process_cli" },
          },
        });
        expect(JSON.stringify(projected)).not.toContain("stack");
        const { error: _label, ...projection } =
          analysisCliErrorEnvelopeSchema.parse(projected);
        const action =
          analysisErrorProjectionSchema.parse(projection).remediation.action;
        expect(action).not.toContain("SECRET");
        expect(action).not.toMatch(/\bretry\b/iu);
        expect(
          await readFile("docs/user-visible-errors.csv", "utf8"),
        ).toContain(action);
      } finally {
        read.mockRestore();
      }
    },
  );
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

it.each(
  [
    {
      label: "EIO",
      physical: Object.assign(new Error("physical descriptor failure"), {
        code: "EIO",
      }),
    },
    { label: "null", physical: null },
    { label: "undefined", physical: undefined },
  ].flatMap((failure) => [
    { ...failure, reader: "native" as const },
    { ...failure, reader: "streamed" as const },
  ]),
)(
  "preserves a $reader descriptor $label when cancellation arrives after the read fails",
  async ({ physical, reader }) => {
    const root = await createTestTempDirectory("rea-process-cli-late-io-");
    const path = join(root, "scenario.json");
    const input = JSON.stringify({
      executable: process.execPath,
      arguments: [],
    });
    await writeFile(path, reader === "streamed" ? stream(input) : input);
    const controller = new AbortController();
    await failFileReadAfterAbort(
      path,
      controller,
      new Error("later caller cancellation"),
      physical,
    );
    try {
      expect(
        await captureProcessScenarioFile(path, process.env, controller.signal),
      ).toMatchObject({
        code: "execution_failure",
        category: "execution_failure",
        retryable: false,
        details: { operation: "read", reason: "io", path },
      });
    } finally {
      vi.restoreAllMocks();
    }
  },
);

it("keeps a physical read primary when its cause is also the abort reason", async () => {
  const root = await createTestTempDirectory(
    "rea-process-cli-identical-abort-",
  );
  const path = join(root, "scenario.json");
  await writeFile(
    path,
    JSON.stringify({ executable: process.execPath, arguments: [] }),
  );
  const controller = new AbortController();
  const physical = new JsonInputPhysicalReadFailure(
    Object.assign(new Error("descriptor EIO"), { code: "EIO" }),
  );
  await failFileReadAfterAbort(path, controller, physical, physical);
  try {
    expect(
      await captureProcessScenarioFile(path, process.env, controller.signal),
    ).toMatchObject({
      code: "execution_failure",
      category: "execution_failure",
      details: { operation: "read", reason: "io", path },
    });
  } finally {
    vi.restoreAllMocks();
  }
});

describe("process CLI input diagnostics", () => {
  it("keeps physical file I/O failures in the execution-error projection", async () => {
    const path = "/selected/scenario.json";
    const ioFailure = new EvidenceFileError("read", "io", {
      cause: Object.assign(new Error("disk I/O failed"), { code: "EIO" }),
      path,
    });
    const read = vi
      .spyOn(jsonFiles, "readJsonFile")
      .mockResolvedValue(err(ioFailure));

    try {
      const result = await captureProcessScenarioFile(path);
      expect(result).toMatchObject({
        error: "Process command failed",
        code: "execution_failure",
        category: "execution_failure",
        retryable: false,
        details: { operation: "read", reason: "io", path },
      });
      expect(analysisCliErrorEnvelopeSchema.safeParse(result).success).toBe(
        true,
      );
    } finally {
      read.mockRestore();
    }
  });

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

    const missing = await captureProcessScenarioFile(
      join(root, "missing.json"),
    );
    expect(missing).toMatchObject({
      error: "Process command failed",
      code: "invalid_request",
      category: "invalid_input",
      message: expect.stringContaining("Process input file could not be read:"),
      retryable: false,
      remediation: {
        action: expect.stringContaining("Correct the listed fields"),
      },
      details: {
        issues: [
          {
            path: ["input_file"],
            reason: "invalid_value",
            message: expect.stringContaining(
              `Process input file could not be read: ${join(root, "missing.json")} (ENOENT`,
            ),
          },
        ],
      },
    });
    expect(analysisCliErrorEnvelopeSchema.safeParse(missing).success).toBe(
      true,
    );

    const invalidJson = await captureProcessScenarioFile(malformed);
    expect(invalidJson).toMatchObject({
      error: "Process command failed",
      code: "invalid_request",
      category: "invalid_input",
      message: expect.stringContaining(
        `Process input file is not valid UTF-8 JSON: ${malformed}`,
      ),
      retryable: false,
      remediation: {
        action: expect.stringContaining("Correct the listed fields"),
      },
      details: {
        issues: [{ path: ["input_file"], reason: "invalid_value" }],
      },
    });
    expect(analysisCliErrorEnvelopeSchema.safeParse(invalidJson).success).toBe(
      true,
    );

    const invalidUtf8Json = await captureProcessScenarioFile(invalidUtf8);
    expect(invalidUtf8Json).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      retryable: false,
      message: expect.stringContaining(
        `Process input file is not valid UTF-8 JSON: ${invalidUtf8}`,
      ),
      details: { issues: [{ path: ["input_file"], reason: "invalid_value" }] },
    });
    expect(
      analysisCliErrorEnvelopeSchema.safeParse(invalidUtf8Json).success,
    ).toBe(true);

    const compareMissing = await compareProcessEvidenceFiles(
      join(root, "missing-left.json"),
      join(root, "missing-right.json"),
    );
    expect(compareMissing).toMatchObject({
      error: "Process command failed",
      code: "invalid_request",
      category: "invalid_input",
      retryable: false,
      details: {
        operation: "compare_process_captures",
        issues: [{ path: ["input_file"], reason: "invalid_value" }],
      },
    });
    expect(
      analysisCliErrorEnvelopeSchema.safeParse(compareMissing).success,
    ).toBe(true);

    expect(await captureProcessScenarioFile(invalid)).toMatchObject({
      error: "Process command failed",
      code: "invalid_request",
      category: "invalid_input",
      message: expect.stringMatching(/input.*invalid/iu),
      retryable: false,
      remediation: {
        action: expect.stringContaining("Correct the listed fields"),
      },
      recovery: {
        kind: "inspect_input_contract",
        operation: "capture_process_scenario",
      },
      details: expect.objectContaining({
        operation: "capture_process_scenario",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["executable"] }),
        ]),
      }),
    });
  });
});

describe("process CLI final cleanup cancellation", () => {
  it.each([
    { kind: "plan", cancel: false },
    { kind: "comparison", cancel: false },
    { kind: "plan", cancel: true },
    { kind: "comparison", cancel: true },
    { kind: "invalid-scenario", cancel: true },
  ] as const)(
    "preserves the $kind outcome through final input cleanup (cancelled: $cancel)",
    async ({ kind, cancel }) => {
      const root = await createTestTempDirectory(
        "rea-process-cli-final-close-",
      );
      const path = join(root, "input.json");
      await writeFile(
        path,
        JSON.stringify(
          kind === "comparison"
            ? processCaptureEvidence()
            : kind === "plan"
              ? {
                  executable: process.execPath,
                  working_directory: root,
                  dry_run: true,
                }
              : {},
        ),
      );
      const controller = new AbortController();
      const reason = { phase: "final-input-close" };
      const realClose = ArtifactResourceScope.prototype.close;
      const close = vi
        .spyOn(ArtifactResourceScope.prototype, "close")
        .mockImplementation(async function (this: ArtifactResourceScope) {
          await realClose.call(this);
          if (cancel) controller.abort(reason);
        });
      try {
        const result =
          kind === "comparison"
            ? await compareProcessEvidenceFiles(
                path,
                path,
                undefined,
                controller.signal,
              )
            : await captureProcessScenarioFile(
                path,
                process.env,
                controller.signal,
              );
        expect(controller.signal.aborted).toBe(cancel);
        if (!cancel) {
          expect(result).toMatchObject({
            operation:
              kind === "plan"
                ? "capture_process_scenario"
                : "compare_process_captures",
          });
          return;
        }
        expect(controller.signal.reason).toBe(reason);
        expect(result).toMatchObject({
          error: "Process command failed",
          code: kind === "invalid-scenario" ? "invalid_request" : "cancelled",
        });
        if (kind !== "invalid-scenario")
          expect(result).toMatchObject({
            details: {
              partial_observation: {
                operation:
                  kind === "plan"
                    ? "capture_process_scenario"
                    : "compare_process_captures",
                predicate_type:
                  kind === "plan"
                    ? "rea.process-scenario-plan"
                    : "rea.process-comparison",
              },
            },
          });
      } finally {
        close.mockRestore();
      }
    },
  );
});

describe("process CLI file cleanup", () => {
  it("retries a transient input close refusal before validating the scenario", async () => {
    const root = await createTestTempDirectory(
      "rea-process-cli-cleanup-retry-",
    );
    const path = join(root, "scenario.json");
    await writeFile(path, "{}");
    let owner: OwnedFileHandle | undefined;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementationOnce(async function (this: OwnedFileHandle) {
        owner = this;
        throw new Error("transient close refusal");
      });
    try {
      expect(await captureProcessScenarioFile(path)).toMatchObject({
        code: "invalid_request",
      });
      expect(close).toHaveBeenCalledTimes(2);
      expect(owner?.handle.fd).toBe(-1);
    } finally {
      close.mockRestore();
      await owner?.close();
    }
  });

  it.each([
    { operation: "capture", cancelDuringClose: false },
    { operation: "capture", cancelDuringClose: true },
    { operation: "compare", cancelDuringClose: false },
    { operation: "compare", cancelDuringClose: true },
  ] as const)(
    "preserves the open-file owner when $operation close fails (cancelled: $cancelDuringClose)",
    async ({ operation, cancelDuringClose }) => {
      const root = await createTestTempDirectory("rea-process-cli-cleanup-");
      const path = join(root, "scenario.json");
      await writeFile(path, JSON.stringify({ executable: process.execPath }));
      const controller = new AbortController();
      const cleanupCause = new Error("injected file close failure");
      let owner: OwnedFileHandle | undefined;
      const close = vi
        .spyOn(OwnedFileHandle.prototype, "close")
        .mockImplementation(async function (this: OwnedFileHandle) {
          owner = this;
          if (cancelDuringClose) controller.abort();
          throw cleanupCause;
        });
      let failure: unknown;
      try {
        try {
          const signal = cancelDuringClose ? controller.signal : undefined;
          if (operation === "capture")
            await captureProcessScenarioFile(path, process.env, signal);
          else await compareProcessEvidenceFiles(path, path, undefined, signal);
        } catch (cause: unknown) {
          failure = cause;
        }
        expect(failure).toBeInstanceOf(ArtifactReaderFailure);
        if (!(failure instanceof ArtifactReaderFailure))
          throw new Error("Expected the retained file handle owner");
        expect(failure.cleanup).toMatchObject({
          reason: expect.stringContaining(cleanupCause.message),
          resources: [path],
        });
        expect(owner?.handle.fd).toBeGreaterThanOrEqual(0);
        expect(failure.cleanupLeases).toHaveLength(1);
        expect(close.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        close.mockRestore();
        if (failure instanceof ArtifactReaderFailure)
          for (const lease of failure.cleanupLeases ?? [])
            await lease.release();
        else await owner?.close();
        expect(owner?.handle.fd).toBe(-1);
      }
    },
  );
});

describe("process CLI UTF-8 input diagnostics", () => {
  it("names a leading byte-order mark instead of quoting it as a token", async () => {
    const path = join(
      await createTestTempDirectory("rea-process-cli-diagnostics-"),
      "scenario.json",
    );
    await writeFile(path, '\uFEFF{"executable":"/bin/echo"}');
    const result = await captureProcessScenarioFile(path);
    expect(result).toMatchObject({
      error: "Process command failed",
      code: "invalid_request",
      category: "invalid_input",
      message: expect.stringMatching(
        /byte-order mark.*UTF-8 without a byte-order mark/iu,
      ),
      details: { issues: [{ path: ["input_file"], reason: "invalid_value" }] },
    });
    expect(result).toMatchObject({ message: expect.stringContaining(path) });
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

it.each([
  { cleanupFails: false, cancel: false },
  { cleanupFails: true, cancel: false },
  { cleanupFails: true, cancel: true },
])(
  "keeps the typed plan failure through final input close (fails: $cleanupFails; cancelled: $cancel)",
  async ({ cleanupFails, cancel }) => {
    const root = await createTestTempDirectory(
      "rea-process-cli-primary-close-",
    );
    const path = join(root, "scenario.json");
    await writeFile(
      path,
      JSON.stringify({
        executable: process.execPath,
        working_directory: join(root, "missing-directory"),
        dry_run: true,
      }),
    );
    const owner = new OwnedFileHandle(await open(path, "r"));
    const controller = new AbortController();
    const reason = { caller: "stop during failed input cleanup" };
    const cleanupCause = new Error("retained input descriptor close failure");
    const realPrepare = scenarioPreparation.prepareProcessScenarioPlan;
    let primary: unknown;
    const preparing = vi
      .spyOn(scenarioPreparation, "prepareProcessScenarioPlan")
      .mockImplementation(async (...args) => {
        const result = await realPrepare(...args);
        if (!result.ok) primary = result.error;
        return result;
      });
    const realFileClose = OwnedFileHandle.prototype.close;
    const closingFile = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        if (this !== owner || !cleanupFails) return realFileClose.call(this);
        if (cancel) controller.abort(reason);
        throw cleanupCause;
      });
    const realScopeClose = ArtifactResourceScope.prototype.close;
    const closingScope = vi
      .spyOn(ArtifactResourceScope.prototype, "close")
      .mockImplementationOnce(async function (this: ArtifactResourceScope) {
        // A real descriptor is retained at the final input-scope boundary;
        // this supplies cleanup authority, not a fabricated ownership receipt.
        this.retain({ kind: "file-handle", resource: path, handle: owner });
        await realScopeClose.call(this);
      });
    let failure: unknown;
    let returned: unknown;
    try {
      try {
        returned = await captureProcessScenarioFile(
          path,
          process.env,
          controller.signal,
        );
      } catch (cause) {
        failure = cause;
      }
      expect(primary).toMatchObject({ _tag: "AnalysisInputError" });
      if (!cleanupFails) {
        expect(returned).toMatchObject({
          code: "invalid_request",
          details: { issues: [{ path: ["working_directory"] }] },
        });
        expect(failure).toBeUndefined();
        return;
      }
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      if (!(failure instanceof ArtifactReaderFailure))
        throw new Error("Expected retained input cleanup failure");
      const causes = new Set<unknown>();
      const pending = [failure as unknown];
      while (pending.length > 0) {
        const cause = pending.pop();
        if (causes.has(cause)) continue;
        causes.add(cause);
        if (cause instanceof Error) pending.push(cause.cause);
        if (cause instanceof AggregateError)
          for (const nested of cause.errors) pending.push(nested);
      }
      expect(causes.has(primary)).toBe(true);
      expect(failure.cleanupLeases).toHaveLength(1);
      expect(owner.handle.fd).toBeGreaterThanOrEqual(0);
      expect(controller.signal.aborted).toBe(cancel);
    } finally {
      preparing.mockRestore();
      closingScope.mockRestore();
      closingFile.mockRestore();
      if (failure instanceof ArtifactReaderFailure)
        for (const lease of failure.cleanupLeases ?? []) await lease.release();
      await owner.close();
      expect(owner.handle.fd).toBe(-1);
    }
  },
);

it.each(["plan", "invalid"] as const)(
  "retains %s and cancellation while final descriptor cleanup fails",
  async (kind) => {
    const root = await createTestTempDirectory("rea-process-mixed-final-");
    const path = join(root, "scenario.json");
    await writeFile(
      path,
      JSON.stringify({
        executable: process.execPath,
        working_directory: kind === "plan" ? root : join(root, "missing"),
        dry_run: true,
      }),
    );
    const owner = new OwnedFileHandle(await open(path, "r"));
    const controller = new AbortController();
    const reason = { caller: "late cancellation" };
    const failureCause = new Error("descriptor close failed");
    const realFileClose = OwnedFileHandle.prototype.close;
    const fileClose = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        if (this !== owner) return realFileClose.call(this);
        controller.abort(reason);
        throw failureCause;
      });
    const realScopeClose = ArtifactResourceScope.prototype.close;
    const scopeClose = vi
      .spyOn(ArtifactResourceScope.prototype, "close")
      .mockImplementationOnce(async function (this: ArtifactResourceScope) {
        this.retain({ kind: "file-handle", resource: path, handle: owner });
        await realScopeClose.call(this);
      });
    let thrown: unknown;
    try {
      try {
        await captureProcessScenarioFile(path, process.env, controller.signal);
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown).toBeInstanceOf(ArtifactReaderFailure);
      if (!(thrown instanceof ArtifactReaderFailure))
        throw new Error("expected retained cleanup");
      if (kind === "plan")
        expect(thrown.partialObservation).toMatchObject({
          operation: "capture_process_scenario",
          predicate_type: "rea.process-scenario-plan",
        });
      const seen = new Set<unknown>();
      const pending: unknown[] = [thrown];
      while (pending.length > 0) {
        const value = pending.pop();
        if (seen.has(value)) continue;
        seen.add(value);
        if (value instanceof Error) pending.push(value.cause);
        if (value instanceof AggregateError) pending.push(...value.errors);
        if (value instanceof AnalysisError)
          pending.push(...value.secondaryFailures);
      }
      expect(seen.has(reason)).toBe(true);
      expect(thrown.cleanupLeases).toHaveLength(1);
    } finally {
      scopeClose.mockRestore();
      fileClose.mockRestore();
      if (thrown instanceof ArtifactReaderFailure)
        for (const lease of thrown.cleanupLeases ?? []) await lease.release();
      await owner.close();
    }
  },
);

it("retains both prior process and input cleanup authority", async () => {
  const { AnalysisCleanupLease } =
    await import("../../../src/artifacts/AnalysisCleanupLease.js");
  const { ProcessCaptureError } =
    await import("../../../src/process/capture/ProcessCaptureError.js");
  const root = await createTestTempDirectory("rea-process-cli-mixed-owners-");
  const path = join(root, "scenario.json");
  await writeFile(
    path,
    JSON.stringify({
      executable: process.execPath,
      working_directory: root,
      dry_run: true,
    }),
  );
  const owner = new OwnedFileHandle(await open(path, "r"));
  const processLease = new AnalysisCleanupLease(async () => {}, [
    "owned process",
  ]);
  const primary = new ProcessCaptureError("process cleanup incomplete", {
    reason: "cleanup_incomplete",
    cleanup: { reason: "process alive", resources: ["owned process"] },
  });
  processLease.bindCleanupError(primary);
  const preparing = vi
    .spyOn(scenarioPreparation, "prepareProcessScenarioPlan")
    .mockResolvedValue(err(primary));
  const realClose = OwnedFileHandle.prototype.close;
  const fileClose = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      if (this === owner) throw new Error("descriptor retained");
      return realClose.call(this);
    });
  const realScopeClose = ArtifactResourceScope.prototype.close;
  const scopeClose = vi
    .spyOn(ArtifactResourceScope.prototype, "close")
    .mockImplementationOnce(async function (this: ArtifactResourceScope) {
      this.retain({ kind: "file-handle", resource: path, handle: owner });
      await realScopeClose.call(this);
    });
  let failure: unknown;
  try {
    try {
      await captureProcessScenarioFile(path);
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    if (!(failure instanceof ArtifactReaderFailure))
      throw new Error("missing failure");
    expect(failure.cleanup?.resources).toContain("owned process");
    expect(failure.cleanupLeases).toBeUndefined();
  } finally {
    preparing.mockRestore();
    fileClose.mockRestore();
    scopeClose.mockRestore();
    if (failure instanceof ArtifactReaderFailure)
      for (const lease of failure.cleanupLeases ?? []) await lease.release();
    await owner.close();
    await processLease.release();
  }
});

it("retains prior error and late cancellation with successful cleanup", async () => {
  const root = await createTestTempDirectory("rea-process-cli-late-success-");
  const path = join(root, "scenario.json");
  await writeFile(
    path,
    JSON.stringify({
      executable: process.execPath,
      working_directory: join(root, "missing"),
      dry_run: true,
    }),
  );
  const controller = new AbortController();
  const reason = { caller: "stop during final cleanup" };
  let primary: AnalysisError | undefined;
  const prepare = scenarioPreparation.prepareProcessScenarioPlan;
  const preparing = vi
    .spyOn(scenarioPreparation, "prepareProcessScenarioPlan")
    .mockImplementation(async (...args) => {
      const result = await prepare(...args);
      if (!result.ok) primary = result.error;
      return result;
    });
  const close = ArtifactResourceScope.prototype.close;
  const closing = vi
    .spyOn(ArtifactResourceScope.prototype, "close")
    .mockImplementationOnce(async function (this: ArtifactResourceScope) {
      controller.abort(reason);
      await close.call(this);
    });
  try {
    const result = await captureProcessScenarioFile(
      path,
      process.env,
      controller.signal,
    );
    expect(result).toMatchObject({ code: "invalid_request" });
    expect(primary).toBeDefined();
    expect(
      primary?.secondaryFailures.some(
        (failure) =>
          failure._tag === "AnalysisCancelledError" && failure.cause === reason,
      ),
    ).toBe(true);
  } finally {
    preparing.mockRestore();
    closing.mockRestore();
  }
});

it("retains independent process and input owners after mixed cleanup failure", async () => {
  const { AnalysisCleanupLease } =
    await import("../../../src/artifacts/AnalysisCleanupLease.js");
  const { ProcessCaptureError } =
    await import("../../../src/process/capture/ProcessCaptureError.js");
  const harness =
    await import("../../../src/process/capture/ProcessHarness.js");
  const root = await createTestTempDirectory("rea-process-cli-mixed-owners-");
  const path = join(root, "scenario.json");
  await writeFile(
    path,
    JSON.stringify({
      executable: process.execPath,
      working_directory: root,
      dry_run: false,
    }),
  );
  const owner = new OwnedFileHandle(await open(path, "r"));
  let failProcess = true;
  const processLease = new AnalysisCleanupLease(async () => {
    if (failProcess) throw new Error("process cleanup failed");
  }, ["owned process"]);
  const primary = new ProcessCaptureError("capture refused");
  const capturing = vi
    .spyOn(harness, "captureProcessScenario")
    .mockImplementation(async (...args) => {
      const scope = args[7];
      if (!scope) throw new Error("missing process scope");
      scope.retain(processLease);
      return err(primary);
    });
  const realClose = OwnedFileHandle.prototype.close;
  const fileClose = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      if (this === owner) throw new Error("descriptor retained");
      return realClose.call(this);
    });
  const realScopeClose = ArtifactResourceScope.prototype.close;
  const scopeClose = vi
    .spyOn(ArtifactResourceScope.prototype, "close")
    .mockImplementationOnce(async function (this: ArtifactResourceScope) {
      this.retain({ kind: "file-handle", resource: path, handle: owner });
      await realScopeClose.call(this);
    });
  let failure: unknown;
  try {
    try {
      await captureProcessScenarioFile(path);
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    if (!(failure instanceof ArtifactReaderFailure))
      throw new Error("missing failure");
    expect(failure.cleanup?.resources).toEqual(
      expect.arrayContaining(["owned process", path]),
    );
    expect(failure.cleanupLeases).toHaveLength(2);
    failProcess = false;
    fileClose.mockRestore();
    for (const lease of failure.cleanupLeases ?? []) await lease.release();
    expect(processLease.released).toBe(true);
    expect(owner.handle.fd).toBe(-1);
  } finally {
    failProcess = false;
    capturing.mockRestore();
    fileClose.mockRestore();
    scopeClose.mockRestore();
    await owner.close();
    await processLease.release();
  }
});

it.each(["completed", "failed"] as const)(
  "retries transient process cleanup after %s capture",
  async (outcome) => {
    const { AnalysisCleanupLease } =
      await import("../../../src/artifacts/AnalysisCleanupLease.js");
    const { ProcessCaptureError } =
      await import("../../../src/process/capture/ProcessCaptureError.js");
    const { ok } = await import("../../../src/domain/result.js");
    const harness =
      await import("../../../src/process/capture/ProcessHarness.js");
    const root = await createTestTempDirectory(
      "rea-process-cli-transient-close-",
    );
    const path = join(root, "scenario.json");
    await writeFile(
      path,
      JSON.stringify({
        executable: process.execPath,
        working_directory: root,
        dry_run: false,
      }),
    );
    let attempts = 0;
    const processLease = new AnalysisCleanupLease(async () => {
      if (++attempts === 1) throw new Error("transient process cleanup");
    }, ["owned process"]);
    const primary = new ProcessCaptureError("capture refused");
    const capturing = vi
      .spyOn(harness, "captureProcessScenario")
      .mockImplementation(async (...args) => {
        const scope = args[7];
        if (!scope) throw new Error("missing process scope");
        scope.retain(processLease);
        return outcome === "completed"
          ? ok(EMPTY_PROCESS_CAPTURE_EXAMPLE as never)
          : err(primary);
      });
    try {
      const result = await captureProcessScenarioFile(path);
      expect(attempts).toBe(2);
      expect(processLease.released).toBe(true);
      if (outcome === "completed")
        expect(result).toMatchObject({ predicate_type: "rea.process-capture" });
      else expect(result).toMatchObject({ message: "capture refused" });
    } finally {
      capturing.mockRestore();
      await processLease.release();
    }
  },
);

it("closes the actual process owner when capture Evidence assembly throws", async () => {
  const { AnalysisCleanupLease } =
    await import("../../../src/artifacts/AnalysisCleanupLease.js");
  const { ok } = await import("../../../src/domain/result.js");
  const harness =
    await import("../../../src/process/capture/ProcessHarness.js");
  const processEvidence =
    await import("../../../src/application/process/ProcessEvidence.js");
  const root = await createTestTempDirectory("rea-process-evidence-finalize-");
  const path = join(root, "scenario.json");
  await writeFile(
    path,
    JSON.stringify({
      executable: process.execPath,
      working_directory: root,
      dry_run: false,
    }),
  );
  let closes = 0;
  const owner = new AnalysisCleanupLease(async () => {
    closes += 1;
  }, ["owned process"]);
  const physical = new Error("Evidence assembly failed");
  const capturing = vi
    .spyOn(harness, "captureProcessScenario")
    .mockImplementation(async (...args) => {
      if (args[7] === undefined) throw new Error("missing process scope");
      args[7].retain(owner);
      return ok(EMPTY_PROCESS_CAPTURE_EXAMPLE as never);
    });
  const projecting = vi
    .spyOn(processEvidence, "createProcessCaptureEvidence")
    .mockImplementation(() => {
      throw physical;
    });
  try {
    const result = await captureProcessScenarioFile(path);
    expect(result).toMatchObject({
      code: "execution_failure",
      message: expect.stringContaining(physical.message),
    });
    expect(closes).toBe(1);
    expect(owner.released).toBe(true);
  } finally {
    projecting.mockRestore();
    capturing.mockRestore();
    await owner.release();
  }
});

it("keeps unknown primary cleanup coverage when late cancellation wraps mixed owners", async () => {
  const { AnalysisCleanupLease } =
    await import("../../../src/artifacts/AnalysisCleanupLease.js");
  const { ProcessCaptureError } =
    await import("../../../src/process/capture/ProcessCaptureError.js");
  const harness =
    await import("../../../src/process/capture/ProcessHarness.js");
  const root = await createTestTempDirectory("rea-process-cli-three-owners-");
  const path = join(root, "scenario.json");
  await writeFile(
    path,
    JSON.stringify({
      executable: process.execPath,
      working_directory: root,
      dry_run: false,
    }),
  );
  const owner = new OwnedFileHandle(await open(path, "r"));
  const controller = new AbortController();
  const reason = { caller: "late cancellation" };
  let failing = true;
  const priorLease = new AnalysisCleanupLease(async () => {}, [
    "prior process",
  ]);
  const scopeLease = new AnalysisCleanupLease(async () => {
    if (failing) throw new Error("scope close failed");
  }, ["other process"]);
  const primary = new ProcessCaptureError("capture refused", {
    reason: "cleanup_incomplete",
    cleanup: { reason: "prior pending", resources: ["prior process"] },
  });
  priorLease.bindCleanupError(primary);
  const capturing = vi
    .spyOn(harness, "captureProcessScenario")
    .mockImplementation(async (...args) => {
      const scope = args[7];
      if (!scope) throw new Error("missing scope");
      scope.retain(scopeLease);
      return err(primary);
    });
  const realClose = OwnedFileHandle.prototype.close;
  const fileClose = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      if (this === owner && failing) {
        controller.abort(reason);
        throw new Error("descriptor retained");
      }
      return realClose.call(this);
    });
  const realScopeClose = ArtifactResourceScope.prototype.close;
  const scopeClose = vi
    .spyOn(ArtifactResourceScope.prototype, "close")
    .mockImplementationOnce(async function (this: ArtifactResourceScope) {
      this.retain({ kind: "file-handle", resource: path, handle: owner });
      await realScopeClose.call(this);
    });
  let failure: unknown;
  try {
    try {
      await captureProcessScenarioFile(path, process.env, controller.signal);
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    if (!(failure instanceof ArtifactReaderFailure))
      throw new Error("missing failure");
    expect(controller.signal.reason).toBe(reason);
    expect(failure.cleanup?.resources).toContain("prior process");
    expect(failure.cleanupLeases).toBeUndefined();
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const local = (failure.cause as AggregateError).errors.find(
      (error) =>
        error instanceof ArtifactReaderFailure &&
        error.cleanupLeases?.length === 2,
    );
    expect(local).toBeInstanceOf(ArtifactReaderFailure);
    failing = false;
    fileClose.mockRestore();
    for (const lease of (local as ArtifactReaderFailure).cleanupLeases ?? [])
      await lease.release();
    expect(scopeLease.released).toBe(true);
    expect(owner.handle.fd).toBe(-1);
    expect(primary.cleanupIncomplete).toBe(true);
  } finally {
    failing = false;
    capturing.mockRestore();
    fileClose.mockRestore();
    scopeClose.mockRestore();
    if (failure instanceof ArtifactReaderFailure)
      for (const lease of failure.cleanupLeases ?? []) await lease.release();
    await owner.close();
    await scopeLease.release();
    await priorLease.release();
  }
});
