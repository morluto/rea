import { chmod, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { systemDoctorHost } from "../../../src/application/Doctor.js";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("target route diagnostics", () => {
  it("identifies the directory opening constraint and gives the direct analysis route", async () => {
    const directory = await createTestTempDirectory("rea-js-target-");
    await writeFile(join(directory, "index.js"), "export const answer = 42;\n");
    const result = await parseBinaryTarget(directory);
    if (result.ok) throw new Error("directory was admitted as a file");
    const projected = projectAnalysisError(result.error);
    expect(projected).toMatchObject({
      code: "target_unavailable",
      details: {
        path: await realpath(directory),
        constraint: "directory_requires_file",
      },
    });
    expect(projected.message).toContain("analyze_javascript_application");
    expect(projected.remediation.action).toContain("input_path");
    const doctor = systemDoctorHost();
    expect(await doctor.inspectTarget?.(directory)).toMatchObject({
      name: "target",
      ok: false,
      classification: "unsupported_target",
      details: { constraint: "directory_requires_file" },
      remediation: projected.remediation.action,
    });
    const missing = await parseBinaryTarget(join(directory, "missing"));
    if (missing.ok) throw new Error("missing target was admitted");
    expect(projectAnalysisError(missing.error)).toMatchObject({
      details: { reason: expect.stringContaining("does not exist") },
      message: expect.stringContaining("does not exist"),
    });
    expect(
      await doctor.inspectTarget?.(join(directory, "missing")),
    ).toMatchObject({
      ok: false,
      classification: "config_drift",
      details: { reason: expect.stringContaining("does not exist") },
    });
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "preserves a real filesystem permission denial",
    async () => {
      const directory = await createTestTempDirectory("rea-target-denied-");
      const path = join(directory, "index.js");
      await writeFile(path, "export const answer = 42;");
      await chmod(path, 0o000);
      try {
        const result = await parseBinaryTarget(path);
        if (result.ok) throw new Error("unreadable target was admitted");
        expect(projectAnalysisError(result.error)).toMatchObject({
          details: { reason: expect.stringContaining("permission denied") },
          message: expect.stringContaining("permission denied"),
        });
        expect(await systemDoctorHost().inspectTarget?.(path)).toMatchObject({
          ok: false,
          classification: "config_drift",
          details: { reason: expect.stringContaining("permission denied") },
        });
      } finally {
        await chmod(path, 0o600);
      }
    },
  );
});
