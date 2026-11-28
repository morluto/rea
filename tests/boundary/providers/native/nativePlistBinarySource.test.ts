import { open, truncate, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished, vi } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../../../src/domain/analysisErrorCore.js";
import { ArtifactFileCleanupFailure } from "../../../../src/resources/ArtifactFileOperation.js";
import { ProviderAdapterError } from "../../../../src/domain/providerAdapterError.js";
import { buildBinary, type PlistValue } from "plist";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import {
  DEFAULT_NATIVE_PLIST_DECODE_BYTES,
  DEFAULT_NATIVE_PLIST_FILE_BYTES,
} from "../../../../src/domain/apple/nativePlistBudgets.js";
import { MAX_JSON_DEPTH } from "../../../../src/domain/jsonValue.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { analysisRefusalRemediation } from "../../../../src/domain/analysisRefusal.js";
import {
  NativeFixtureRunner,
  nativeMachoTarget,
} from "../../../fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

class BinaryNativeRunner extends NativeFixtureRunner {
  readonly tools: string[] = [];

  override async run(tool: string, arguments_: readonly string[]) {
    this.tools.push(tool);
    return super.run(tool, arguments_);
  }
}

const binaryPath = async () => {
  const root = await createTestTempDirectory("rea-native-binary-plist-");
  const path = join(root, "selected.plist");
  await writeFile(path, Buffer.from("bplist00"));
  return { root, path };
};

const binaryClient = (root: string, runner: BinaryNativeRunner) => {
  const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
    nativeMachoTarget(join(root, "target")),
  );
  onTestFinished(async () => {
    await client.close();
  });
  return client;
};

it("reports a binary source-size refusal as a typed parameter limit and honors per-call max_file_bytes", async () => {
  const { root, path } = await binaryPath();
  await truncate(path, DEFAULT_NATIVE_PLIST_FILE_BYTES + 1);
  const runner = new BinaryNativeRunner({
    file: "Apple binary property list\n",
  });
  const client = binaryClient(root, runner);

  const result = await client.execute("inspect_plist", { path });
  if (result.ok) throw new Error("Expected file-size refusal");
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(result.error).toMatchObject({
    resource: "file-size",
    reportedLimits: { maximum_input_bytes: DEFAULT_NATIVE_PLIST_FILE_BYTES },
    retryable: false,
    limit: {
      control_kind: "parameter",
      parameter: "max_file_bytes",
      effective_value: DEFAULT_NATIVE_PLIST_FILE_BYTES,
      unit: "bytes",
      minimum: 1,
      maximum: DEFAULT_NATIVE_PLIST_FILE_BYTES,
      default_value: DEFAULT_NATIVE_PLIST_FILE_BYTES,
      applies_at: "next_call",
      required_value: DEFAULT_NATIVE_PLIST_FILE_BYTES + 1,
    },
  });
  const projected = projectAnalysisError(result.error);
  expect(projected).toMatchObject({
    code: "resource_constraint",
    retryable: false,
    details: {
      limit: result.error.limit,
      refusal: {
        kind: "adjustable_budget",
        operation: "inspect_plist",
        control: "max_file_bytes",
        effective_value: DEFAULT_NATIVE_PLIST_FILE_BYTES,
        unit: "bytes",
        range: { minimum: 1, maximum: DEFAULT_NATIVE_PLIST_FILE_BYTES },
        default_value: DEFAULT_NATIVE_PLIST_FILE_BYTES,
        required_value: DEFAULT_NATIVE_PLIST_FILE_BYTES + 1,
      },
    },
  });
  expect(projected.remediation.action).toContain("max_file_bytes");
  expect(runner.tools).toEqual([]);

  const smallSource = Buffer.from(buildBinary({ key: "value" }));
  await writeFile(path, smallSource);
  const customRefused = await client.execute("inspect_plist", {
    path,
    max_file_bytes: 8,
  });
  if (customRefused.ok)
    throw new Error("Expected custom max_file_bytes refusal");
  expect(
    projectAnalysisError(customRefused.error).details?.limit,
  ).toMatchObject({
    parameter: "max_file_bytes",
    effective_value: 8,
    required_value: smallSource.length,
  });
  const customAdmitted = await client.execute("inspect_plist", {
    path,
    max_file_bytes: smallSource.length,
  });
  expect(customAdmitted.ok).toBe(true);

  const invalidBudget = await client.execute("inspect_plist", {
    path,
    max_file_bytes: 0,
  });
  if (invalidBudget.ok) throw new Error("Expected invalid max_file_bytes");
  expect(invalidBudget.error).toBeInstanceOf(AnalysisInputError);
});

const nested = (depth: number): PlistValue =>
  depth === 0 ? 1 : [nested(depth - 1)];

it("reports binary plist decode exhaustion with details.limit and honors per-call max_decoded_bytes", async () => {
  const { root, path } = await binaryPath();
  const payload = Buffer.from(buildBinary({ data: Buffer.alloc(4096, 0x78) }));
  await writeFile(path, payload);
  const runner = new BinaryNativeRunner({
    file: "Apple binary property list\n",
  });
  const client = binaryClient(root, runner);

  const refused = await client.execute("inspect_plist", {
    path,
    max_decoded_bytes: 1024,
  });
  if (refused.ok) throw new Error("Expected decode budget refusal");
  expect(refused.error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(refused.error).toMatchObject({
    resource: "memory",
    reportedLimits: { boundary: "plist-decode-bytes", maximum: 1024 },
    retryable: false,
    limit: {
      control_kind: "parameter",
      parameter: "max_decoded_bytes",
      effective_value: 1024,
      unit: "bytes",
      minimum: 1,
      maximum: DEFAULT_NATIVE_PLIST_DECODE_BYTES,
      default_value: DEFAULT_NATIVE_PLIST_DECODE_BYTES,
      applies_at: "next_call",
    },
  });
  const projected = projectAnalysisError(refused.error);
  expect(projected).toMatchObject({
    code: "resource_constraint",
    retryable: false,
    details: {
      resource: "memory",
      limit: refused.error.limit,
      refusal: {
        kind: "adjustable_budget",
        operation: "inspect_plist",
        control: "max_decoded_bytes",
      },
    },
  });
  expect(projected.remediation.action).toContain("max_decoded_bytes");
  expect(runner.tools).toEqual(["file"]);

  const admitted = await client.execute("inspect_plist", {
    path,
    max_decoded_bytes: 128 * 1024,
  });
  expect(admitted.ok).toBe(true);
});

it("names the fixed binary plist nesting allowance instead of host memory", async () => {
  const { root, path } = await binaryPath();
  await writeFile(path, buildBinary(nested(MAX_JSON_DEPTH - 1)));
  const runner = new BinaryNativeRunner({
    file: "Apple binary property list\n",
  });
  const client = binaryClient(root, runner);

  const result = await client.execute("inspect_plist", { path });
  if (result.ok) throw new Error("Expected nesting allowance refusal");
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(result.error).toMatchObject({
    resource: "memory",
    reportedLimits: {
      boundary: "plist-nesting-depth",
      maximum: MAX_JSON_DEPTH - 3,
    },
    retryable: false,
    fixedAllowance: { kind: "parser" },
  });
  const projected = projectAnalysisError(result.error);
  expect(projected).toMatchObject({
    code: "resource_constraint",
    retryable: false,
    details: {
      resource: "memory",
      reported_limits: {
        boundary: "plist-nesting-depth",
        maximum: MAX_JSON_DEPTH - 3,
      },
      refusal: {
        kind: "fixed_ceiling",
        allowance_kind: "parser",
        allowance: "The native plist nesting allowance",
        limit: MAX_JSON_DEPTH - 3,
        unit: "levels",
      },
    },
  });
  expect(projected.remediation.action).toBe(
    analysisRefusalRemediation({
      kind: "fixed_ceiling",
      operation: "inspect_plist",
      ceiling: {
        name: "The native plist nesting allowance",
        kind: "parser",
        limit: MAX_JSON_DEPTH - 3,
        unit: "levels",
      },
    }),
  );
  expect(runner.tools).toEqual(["file"]);
});

it("keeps a malformed binary plist as a selected-input failure", async () => {
  const { root, path } = await binaryPath();
  await writeFile(path, Buffer.from("bplist00bad"));
  const runner = new BinaryNativeRunner({
    file: "Apple binary property list\n",
  });
  const client = binaryClient(root, runner);

  const result = await client.execute("inspect_plist", { path });
  if (result.ok) throw new Error("Expected malformed input failure");
  expect(result.error).toBeInstanceOf(AnalysisInputError);
  expect(runner.tools).toEqual(["file"]);
});

it("rejects a reachable binary date with an invalid marker before projection", async () => {
  const { root, path } = await binaryPath();
  const bytes = Buffer.from(
    buildBinary({ date: new Date("2001-01-01T00:00:00.100Z") }),
  );
  // Date marker followed by 0.1 seconds since the 2001 plist epoch.
  const encodedDate = Buffer.from("333fb999999999999a", "hex");
  const offset = bytes.indexOf(encodedDate);
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(bytes.indexOf(encodedDate, offset + 1)).toBe(-1);
  bytes[offset] = 0x30;
  await writeFile(path, bytes);
  const runner = new BinaryNativeRunner({
    file: "Apple binary property list\n",
  });
  const client = binaryClient(root, runner);

  const result = await client.execute("inspect_plist", { path });

  if (result.ok) throw new Error("Expected malformed date input failure");
  expect(result.error).toBeInstanceOf(AnalysisInputError);
  expect(result.error).toMatchObject({
    issues: [
      {
        path: ["path"],
        reason: "invalid_value",
      },
    ],
  });
  expect(runner.tools).toEqual(["file"]);
});

it("preserves the exact caller cancellation reason during a binary read", async () => {
  const { root, path } = await binaryPath();
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const originalRead = prototype.read;
  const reason = { caller: "binary-plist-read" };
  const controller = new AbortController();
  const read = vi
    .spyOn(prototype, "read")
    .mockImplementationOnce(async function (
      this: FileHandle,
      ...args: Parameters<FileHandle["read"]>
    ) {
      const result = await Reflect.apply(originalRead, this, args);
      controller.abort(reason);
      return result;
    });
  onTestFinished(() => read.mockRestore());
  const client = binaryClient(
    root,
    new BinaryNativeRunner({ file: "Apple binary property list\n" }),
  );

  const result = await client.execute(
    "inspect_plist",
    { path },
    { signal: controller.signal },
  );
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
});

it("preserves a physical EIO when a pending binary read is then aborted", async () => {
  const { root, path } = await binaryPath();
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const reason = { caller: "abort-then-eio" };
  const primary = Object.assign(new Error("controlled binary read EIO"), {
    code: "EIO",
  });
  const controller = new AbortController();
  const read = vi
    .spyOn(prototype, "read")
    .mockImplementationOnce(async function (this: FileHandle) {
      controller.abort(reason);
      throw primary;
    });
  onTestFinished(() => read.mockRestore());
  const client = binaryClient(
    root,
    new BinaryNativeRunner({ file: "Apple binary property list\n" }),
  );

  const result = await client.execute(
    "inspect_plist",
    { path },
    { signal: controller.signal },
  );

  if (result.ok) throw new Error("Expected physical read failure");
  expect(result.error).toBeInstanceOf(ProviderAdapterError);
  expect(result.error.cause).toBe(primary);
});

it("retains the exact binary descriptor owner when reading and closing fail", async () => {
  const { root, path } = await binaryPath();
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const primary = Object.assign(new Error("controlled binary read failure"), {
    code: "EIO",
  });
  const cleanup = new Error("controlled binary descriptor close failure");
  let attempts = 0;
  let release: (() => Promise<void>) | undefined;
  const read = vi
    .spyOn(prototype, "read")
    .mockImplementationOnce(async function (this: FileHandle) {
      release = this.close.bind(this);
      this.close = async () => {
        attempts += 1;
        if (attempts < 3) throw cleanup;
        await release!();
      };
      throw primary;
    });
  onTestFinished(async () => {
    read.mockRestore();
    await release?.();
  });
  const client = binaryClient(
    root,
    new BinaryNativeRunner({ file: "Apple binary property list\n" }),
  );

  const result = await client.execute("inspect_plist", { path });
  if (result.ok) throw new Error("Expected failed read and close");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toContain(path);
  expect(result.error.cause).toBeInstanceOf(ArtifactFileCleanupFailure);
  const failure = result.error.cause as ArtifactFileCleanupFailure;
  expect(failure.fileCleanupFailure.outcome).toEqual({
    kind: "failed",
    cause: primary,
  });
  expect(failure.fileCleanupFailure.cleanupCause).toBe(cleanup);

  expect((await client.close()).ok).toBe(false);
  expect(attempts).toBe(2);
  expect((await client.close()).ok).toBe(true);
  expect(attempts).toBe(3);
  expect(result.error.cleanupIncomplete).toBe(false);
});
