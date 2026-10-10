import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, it as test } from "vitest";
import {
  firmwareFixture,
  assertFirmwareCleanup,
} from "../../fixtures/firmware/provider.js";
import { firmwareResultSchemas } from "../../../src/domain/firmware/firmwareAnalysis.js";
import { FirmwareAnalysisService } from "../../../src/application/firmware/FirmwareAnalysisService.js";
import { FirmwareProvider } from "../../../src/firmware/FirmwareProvider.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";

const delivery = new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE);

const it = test.skipIf(process.platform !== "linux");

it("keeps cleanup-failure state local to the selected factory instance", async () => {
  const failed = await firmwareFixture("cleanup-failure");
  const healthy = await firmwareFixture();
  const failure = await failed.service.execute("inspect_firmware_regions", {
    path: failed.path,
  });
  expect(failure).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  const result = await healthy.service.execute("inspect_firmware_regions", {
    path: healthy.path,
  });
  expect(result.ok).toBe(true);
  await assertFirmwareCleanup(healthy.launches);
});

it("binds region observations to exact bytes and preserves provider-reported uncertainty", async () => {
  const fixture = await firmwareFixture();
  const result = await fixture.service.execute("inspect_firmware_regions", {
    path: fixture.path,
  });
  if (!result.ok) throw result.error;
  const normalized = firmwareResultSchemas.inspect_firmware_regions.parse(
    result.value.normalized_result,
  );
  expect(normalized.regions[0]).toMatchObject({
    offset: 2,
    reported_size: 4,
    size_basis: "provider_reported_validation_unknown",
  });
  expect(result.value.subject?.local_path).toBe(fixture.path);
  expect(result.value.subject?.format).toBe("file");
  expect(result.value.raw_result).toMatchObject({
    report: [{ Analysis: { file_map: [{ id: "hit" }] } }],
  });
  expect(fixture.launches[1]?.args).toEqual(
    expect.arrayContaining(["--as=1073741824", "--threads", "1"]),
  );
  await assertFirmwareCleanup(fixture.launches);
});

it.each(["wrong-input", "bounds"])(
  "rejects a mismatched or out-of-bounds inspection: %s",
  async (mode) => {
    const fixture = await firmwareFixture(mode);
    const result = await fixture.service.execute("inspect_firmware_regions", {
      path: fixture.path,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
    await assertFirmwareCleanup(fixture.launches);
  },
);

it("extracts a selected interval with verified file identity and parent-byte lineage", async () => {
  const fixture = await firmwareFixture();
  const result = await fixture.service.execute("extract_firmware", {
    path: fixture.path,
    output_directory: fixture.output,
    range: { offset: 2, length: 4 },
  });
  if (!result.ok) throw result.error;
  const normalized = firmwareResultSchemas.extract_firmware.parse(
    result.value.normalized_result,
  );
  expect(normalized.selection).toMatchObject({ offset: 2, length: 4 });
  expect(normalized.files[0]).toMatchObject({
    relative_path: "rootfs/config",
    size: 14,
    original_file_range: null,
    runtime_address: null,
  });
  expect(normalized.chunks[0]?.root_file_range).toEqual({
    offset: 2,
    length: 4,
  });
  expect(normalized.derivations[0]).toMatchObject({
    parent_path: "$input",
    child_path: "$output/rootfs/config",
    handler: "gzip",
    parent_file_range: { offset: 0, length: 4 },
  });
  expect(await readFile(normalized.files[0]?.path ?? "", "utf8")).toBe(
    "firmware=true\n",
  );
  expect(fixture.launches[1]?.args).toEqual(
    expect.arrayContaining(["--process-num", "1", "--randomness-depth", "0"]),
  );
  expect(fixture.launches[1]?.args).not.toContain("--no-sandbox");
  await assertFirmwareCleanup(fixture.launches);
});

it.each(["depth", "dependency", "link"])(
  "reports partial extraction for %s without losing inline results",
  async (mode) => {
    const fixture = await firmwareFixture(mode);
    const result = await fixture.service.execute("extract_firmware", {
      path: fixture.path,
      output_directory: fixture.output,
    });
    if (!result.ok) throw result.error;
    const normalized = firmwareResultSchemas.extract_firmware.parse(
      result.value.normalized_result,
    );
    expect(normalized.coverage).toBe("partial");
    expect(normalized.files).toHaveLength(1);
    if (mode === "depth")
      expect(normalized.depth_limited_paths).toEqual(["$output/rootfs/config"]);
    if (mode === "dependency")
      expect(normalized.diagnostics).toEqual([
        {
          input_path: "$input",
          report: {
            __typename__: "ExtractorDependencyNotFoundReport",
            severity: "ERROR",
            dependencies: ["sasquatch"],
          },
        },
      ]);
    if (mode === "link") {
      expect(normalized.unpublished_entries).toEqual([
        {
          relative_path: "escape",
          kind: "symlink",
          link_target: "/etc/passwd",
        },
      ]);
      await expect(access(`${fixture.output}/escape`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    await assertFirmwareCleanup(fixture.launches);
  },
);

it("distinguishes a real output file named $input from the selected original", async () => {
  const fixture = await firmwareFixture("reserved-name");
  const outcome = await fixture.service.execute("extract_firmware", {
    path: fixture.path,
    output_directory: fixture.output,
  });
  if (!outcome.ok) throw outcome.error;
  const result = firmwareResultSchemas.extract_firmware.parse(
    outcome.value.normalized_result,
  );
  expect(result.files[0]?.relative_path).toBe("$input");
  expect(result.derivations[0]).toMatchObject({
    parent_path: "$input",
    child_path: "$output/$input",
  });
  expect(await readFile(`${fixture.output}/$input`, "utf8")).toBe(
    "firmware=true\n",
  );
  await assertFirmwareCleanup(fixture.launches);
});

it.each(["hash", "malformed", "budget", "missing-file"])(
  "rejects invalid or over-budget extraction and rolls back output: %s",
  async (mode) => {
    const fixture = await firmwareFixture(mode);
    const result = await fixture.service.execute("extract_firmware", {
      path: fixture.path,
      output_directory: fixture.output,
      ...(mode === "budget" ? { max_output_bytes: 1000 } : {}),
    });
    expect(result.ok).toBe(false);
    await expect(access(fixture.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await assertFirmwareCleanup(fixture.launches);
  },
);

it("preserves existing output and rejects invalid intervals before invoking extraction", async () => {
  const fixture = await firmwareFixture();
  await mkdir(fixture.output);
  await writeFile(`${fixture.output}/existing`, "keep");
  const existing = await fixture.service.execute("extract_firmware", {
    path: fixture.path,
    output_directory: fixture.output,
  });
  expect(existing.ok).toBe(false);
  expect(await readFile(`${fixture.output}/existing`, "utf8")).toBe("keep");
  const previous = fixture.launches.length;
  const invalid = await fixture.service.execute("extract_firmware", {
    path: fixture.path,
    output_directory: fixture.output,
    range: { offset: 100, length: 1 },
  });
  expect(invalid).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  expect(fixture.launches).toHaveLength(previous);
  await assertFirmwareCleanup(fixture.launches);
});

it("retains startup stderr when Unblob exits 1 without a report", async () => {
  const fixture = await firmwareFixture("startup");
  const result = await fixture.service.execute("extract_firmware", {
    path: fixture.path,
    output_directory: fixture.output,
  });
  if (result.ok) throw new Error("Expected startup failure");
  const details = {
    diagnostics: {
      stderr: expect.stringContaining("Landlock sandbox is not available"),
      exit_code: 1,
    },
  };
  expect(projectAnalysisError(result.error)).toMatchObject({ details });
  expect(
    delivery.toCallToolResult(result, toolContract("extract_firmware"))
      .structuredContent,
  ).toMatchObject({ error: { details } });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "ProviderAdapterError",
      diagnostics: {
        exit_code: 1,
        stderr: expect.stringContaining("Landlock sandbox is not available"),
        report_failure: expect.stringContaining("ENOENT"),
      },
    },
  });
  await expect(access(fixture.output)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await assertFirmwareCleanup(fixture.launches);
});

it("distinguishes a successful process with missing output from startup failure", async () => {
  const fixture = await firmwareFixture("missing-report");
  const result = await fixture.service.execute("extract_firmware", {
    path: fixture.path,
    output_directory: fixture.output,
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisOutputError",
      reason: expect.stringContaining("expected complete report"),
    },
  });
  if (result.ok) throw new Error("Expected missing-output failure");
  expect(projectAnalysisError(result.error)).toMatchObject({
    details: { reason: expect.stringContaining("Producer forgot its report") },
  });
  await assertFirmwareCleanup(fixture.launches);
});

it("cancels an owned active process and permits the next queued operation", async () => {
  const fixture = await firmwareFixture("stall");
  const controller = new AbortController();
  const pending = fixture.service.execute(
    "inspect_firmware_regions",
    { path: fixture.path },
    { signal: controller.signal },
  );
  await expect.poll(() => fixture.launches.length).toBe(2);
  controller.abort();
  expect(await pending).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  const cancelled = await fixture.service.execute(
    "inspect_firmware_regions",
    { path: fixture.path },
    { signal: AbortSignal.abort() },
  );
  expect(cancelled).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  expect(fixture.launches).toHaveLength(2);
  await assertFirmwareCleanup(fixture.launches);
});

it("cancels a waiting request promptly while keeping later launches behind the active operation", async () => {
  const fixture = await firmwareFixture("stall");
  const activeController = new AbortController();
  const active = fixture.service.execute(
    "inspect_firmware_regions",
    { path: fixture.path },
    { signal: activeController.signal },
  );
  await expect.poll(() => fixture.launches.length).toBe(2);
  const queuedController = new AbortController();
  const queued = fixture.service.execute(
    "inspect_firmware_regions",
    { path: fixture.path },
    { signal: queuedController.signal },
  );
  queuedController.abort();
  expect(await queued).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  expect(fixture.launches).toHaveLength(2);
  activeController.abort();
  expect((await active).ok).toBe(false);
  await assertFirmwareCleanup(fixture.launches);
});

it("retains an uncertain workspace and lets the next operation create a new root", async () => {
  const fixture = await firmwareFixture("cleanup-failure");
  const first = await fixture.service.execute("inspect_firmware_regions", {
    path: fixture.path,
  });
  expect(first).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  const workspace = fixture.launches[0]?.cwd;
  expect(workspace).toBeDefined();
  if (workspace === undefined) return;
  await access(workspace);
  const next = await fixture.service.execute("inspect_firmware_regions", {
    path: fixture.path,
  });
  expect(next).toMatchObject({ ok: false, error: { cleanupIncomplete: true } });
  expect(fixture.launches).toHaveLength(2);
  const nextWorkspace = fixture.launches[1]?.cwd;
  expect(nextWorkspace).toBeDefined();
  expect(nextWorkspace).not.toBe(workspace);
  await access(workspace);
  if (nextWorkspace !== undefined) await access(nextWorkspace);
});

it("accepts another build on the verified release line and reports it", async () => {
  const fixture = await firmwareFixture("normal", "binwalk 3.1.2");
  const result = await fixture.service.execute("inspect_firmware_regions", {
    path: fixture.path,
  });
  if (!result.ok) throw result.error;
  expect(result.value.provider.version).toBe("3.1.2");
  expect(result.value.limitations.join("\n")).toContain(
    "verified against 3.1.0",
  );
  expect(result.value.normalized_result).toMatchObject({
    engine: { version: "3.1.2" },
  });
  await assertFirmwareCleanup(fixture.launches);
});

it("names the accepted release line when the banner is another line", async () => {
  const fixture = await firmwareFixture("normal", "binwalk 3.2.0");
  const result = await fixture.service.execute("inspect_firmware_regions", {
    path: fixture.path,
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCapabilityUnavailableError",
      reason: expect.stringContaining("Binwalk 3.1.x"),
    },
  });
  await assertFirmwareCleanup(fixture.launches);
});

it("rejects absent or unsupported engines without installing anything", async () => {
  const missing = await new FirmwareAnalysisService(
    new FirmwareProvider({}),
  ).execute("inspect_firmware_regions", { path: "/tmp/unused" });
  expect(missing).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  const fixture = await firmwareFixture("version");
  const result = await fixture.service.execute("inspect_firmware_regions", {
    path: fixture.path,
  });
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  await assertFirmwareCleanup(fixture.launches);
});
