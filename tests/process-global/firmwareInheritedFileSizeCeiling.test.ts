import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { AnalysisResourceConstraintError } from "../../src/domain/analysisErrorCore.js";
import { FIRMWARE_LIMITS } from "../../src/firmware/FirmwareRelease.js";
import { firmwareFileSizeService } from "../fixtures/firmware/fileSizeProducer.js";
import { assertFirmwareCleanup } from "../fixtures/firmware/provider.js";

const execFileAsync = promisify(execFile);
const budget = 16 * 1024 * 1024;

// Lowers this isolated fork's soft RLIMIT_FSIZE to the staging budget, which
// removes the one byte of headroom the producer limit normally keeps.
it.skipIf(process.platform !== "linux")(
  "rejects a staged file that reaches an inherited file-size ceiling",
  async () => {
    const limits = await readFile("/proc/self/limits", "utf8");
    const soft = /^Max file size\s+(\S+)/mu.exec(limits)?.[1];
    if (soft === undefined) throw new Error("No inherited file-size limit");
    const setSoftLimit = async (value: string): Promise<void> => {
      await execFileAsync("prlimit", [
        "--pid",
        String(process.pid),
        `--fsize=${value}:`,
      ]);
    };
    await setSoftLimit(String(budget));
    onTestFinished(() => setSoftLimit(soft));
    const fixture = await firmwareFileSizeService({
      attemptedBytes: budget + 4096,
      probeFileBytes: FIRMWARE_LIMITS.reportBytes + 1,
      extractionFileBytes: budget,
    });
    const outcome = await fixture.service.execute("extract_firmware", {
      path: fixture.path,
      output_directory: fixture.output,
      max_output_bytes: budget,
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        resource: "file-size",
        reportedLimits: { file_size_bytes: budget },
        retryable: false,
      },
    });
    if (outcome.ok) throw new Error("Expected a file-size refusal");
    if (!(outcome.error instanceof AnalysisResourceConstraintError))
      throw outcome.error;
    // Inventory identifies the inherited ceiling and its recovery independently
    // of the producer's SIGXFSZ guidance.
    const recovery = outcome.error.remediationAction;
    expect(recovery).toContain(String(budget));
    expect(recovery).toMatch(/inherited.*file-size limit.*RLIMIT_FSIZE/iu);
    expect(recovery).toMatch(/raise the file-size limit.*ulimit -f/iu);
    expect(recovery).toMatch(/analysis_timeout_ms does not raise it/iu);
    expect(recovery).toMatch(/unchanged request fails/iu);
    await expect(access(fixture.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await assertFirmwareCleanup(fixture.launches);
  },
);
