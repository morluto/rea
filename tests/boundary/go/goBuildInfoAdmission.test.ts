import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { AnalysisSettings } from "../../../src/application/AnalysisSettings.js";
import { createGoBinaryService } from "../../../src/composition/go.js";
import { GoBinaryProvider } from "../../../src/go/GoBinaryProvider.js";
import { readGoBinaryImage } from "../../../src/go/GoBinaryImage.js";
import { goBinarySchema } from "../../../src/domain/go/goBinary.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { goBuildInfoAdmissionFixture } from "../../fixtures/go/admission.js";
import { createGoBinaryFixture } from "../../fixtures/go/image.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../../../src/native/metadata/BinaryContainer.js";
import { readBinaryContainer } from "../../../src/native/metadata/readBinaryContainer.js";
import { GoReportLimitFailure } from "../../../src/go/GoReportBudget.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("delivers plain text at the full 2 MiB ceiling and refuses dense expansion during parsing", () => {
  const fixture = goBuildInfoAdmissionFixture(2097152);
  const report = readGoBinaryImage(fixture.bytes, 2097152);
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(8388608);
  expect(report.build_info?.module_bytes_base64).toBe(
    fixture.moduleBytes.toString("base64"),
  );
  const dense = Buffer.from(
    "dep\tp\tv\n".repeat(Math.floor((fixture.moduleBytes.length - 33) / 8)),
  );
  dense.copy(fixture.bytes, fixture.moduleOffset + 16);
  expect(() => readGoBinaryImage(fixture.bytes, 2097152)).toThrow(
    GoReportLimitFailure,
  );
});

it.each(["inline", "pointer"] as const)(
  "refuses a declared %s string above the configurable ceiling before decoding its contents",
  (encoding) => {
    const fixture = createGoBinaryFixture({ encoding });
    if (encoding === "inline")
      fixture.bytes.set([0x81, 0x80, 0x80, 0x01], fixture.headerOffset + 32);
    else fixture.bytes.writeBigUInt64LE(2097153n, 1544);
    try {
      readGoBinaryImage(fixture.bytes, 2097152);
      throw new Error("Oversized string was accepted");
    } catch (cause) {
      expect(cause).toBeInstanceOf(BinaryResourceFailure);
      expect(cause).toMatchObject({
        boundary: "build-info",
        maximum_bytes: 2097152,
      });
    }
  },
);

it.each(["inline", "pointer"] as const)(
  "retries the same oversized %s record after updating admission and refuses it after reset",
  async (encoding) => {
    const bytes = 1048577;
    const fixture = goBuildInfoAdmissionFixture(bytes, encoding);
    const root = await createTestTempDirectory("rea-go-admission-");
    const path = join(root, "padded.elf");
    await writeFile(path, fixture.bytes);
    const settings = new AnalysisSettings({});
    const service = createGoBinaryService({}, settings.read);
    onTestFinished(() => service.close());
    const inspect = () => settings.run(() => service.inspect({ path }));
    const denied = await inspect();
    if (denied.ok) throw new Error("Default must refuse oversized record");
    expect(projectAnalysisError(denied.error)).toMatchObject({
      code: "resource_constraint",
      details: {
        limit: {
          setting: "go.max_build_info_bytes",
          effective_value: 1048576,
          maximum: 2097152,
          source: "default",
          unit: "bytes",
          applies_at: "next_operation",
        },
      },
    });
    expect(
      settings.update({
        changes: [
          { setting: "go.max_build_info_bytes", action: "set", value: bytes },
        ],
      }).ok,
    ).toBe(true);
    const admitted = await inspect();
    if (!admitted.ok) throw admitted.error;
    expect(
      goBinarySchema.parse(admitted.value.normalized_result).build_info
        ?.module_bytes_base64,
    ).toBe(fixture.moduleBytes.toString("base64"));
    expect(
      settings.update({
        changes: [{ setting: "go.max_build_info_bytes", action: "reset" }],
      }).ok,
    ).toBe(true);
    expect((await inspect()).ok).toBe(false);
    // Neither a higher allowance nor a prior successful read admits truncation.
    const truncated = Buffer.from(
      fixture.bytes.subarray(
        0,
        fixture.moduleOffset + fixture.moduleBytes.length - 1,
      ),
    );
    truncated.writeBigUInt64LE(BigInt(truncated.length), 160);
    truncated.writeBigUInt64LE(BigInt(truncated.length), 168);
    // Keep the native container valid so this reaches the Go string owner.
    expect(readBinaryContainer(truncated).format).toBe("elf");
    try {
      readGoBinaryImage(truncated, bytes);
      throw new Error("Truncated Go string was accepted");
    } catch (cause) {
      expect(cause).toBeInstanceOf(BinaryFormatFailure);
      expect(cause).toMatchObject({
        kind: "malformed",
        message:
          encoding === "inline"
            ? "Go build-info string range is truncated"
            : "Virtual address or string range is not file mapped",
      });
    }
  },
);

it("reports launch provenance and retains the separate complete-report ceiling", async () => {
  const root = await createTestTempDirectory("rea-go-report-limit-");
  const path = join(root, "large.elf");
  const fixture = goBuildInfoAdmissionFixture(2 * 1024 * 1024);
  fixture.bytes.fill(
    1,
    fixture.moduleOffset + 16,
    fixture.moduleOffset + fixture.moduleBytes.length - 17,
  );
  await writeFile(path, fixture.bytes);
  const service = createGoBinaryService({
    REA_GO_MAX_BUILD_INFO_BYTES: "2097152",
  });
  onTestFinished(() => service.close());
  const result = await service.inspect({ path });
  if (result.ok) throw new Error("Large complete report must be refused");
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      resource: "transport",
      reported_limits: { maximum_output_bytes: 8388608 },
    },
  });
  const provider = new GoBinaryProvider(() => ({
    ok: true,
    value: { maximumBytes: 1, source: "setting" },
  }));
  onTestFinished(() => provider.close());
  const denied = await provider.inspect({ path });
  if (denied.ok) throw new Error("Launch allowance must be enforced");
  expect(projectAnalysisError(denied.error)).toMatchObject({
    details: { limit: { effective_value: 1, source: "setting" } },
  });
});
