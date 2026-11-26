import { createHash } from "node:crypto";
import { fileIdentity } from "../../fixtures/evidenceSubject.js";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKernelModuleService } from "../../../src/composition/binaryDiagnostics/kernelModule.js";
import { kernelModuleSchema } from "../../../src/domain/native/kernelModule.js";
import {
  kernelModuleFixture,
  moduleSignatureTrailer,
} from "../../../src/native/elf/KernelModule.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { expectFileSelectionErrors } from "../../support/expectFileSelectionErrors.js";

describe("kernel module stable filesystem boundary", () => {
  it("names max_structure_bytes when its section table exceeds it", async () => {
    const root = await createTestTempDirectory("rea-kernel-module-structure-");
    const path = join(root, "demo.ko");
    await writeFile(path, kernelModuleFixture());
    const service = createKernelModuleService();
    try {
      const refused = await service.inspect({ path, max_structure_bytes: 64 });
      if (refused.ok) throw new Error("Expected a max_structure_bytes refusal");
      expect(refused.error).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
        limit: {
          control_kind: "parameter",
          parameter: "max_structure_bytes",
          effective_value: 64,
          applies_at: "next_call",
        },
      });
      const raised = await service.inspect({
        path,
        max_structure_bytes: 65536,
      });
      if (!raised.ok) throw raised.error;
    } finally {
      await service.close();
    }
  });

  it("retains trailer fields but withholds an empty PKCS#7 range", async () => {
    const root = await createTestTempDirectory("rea-kernel-module-empty-sig-");
    const path = join(root, "demo.ko");
    await writeFile(
      path,
      kernelModuleFixture({
        signature: moduleSignatureTrailer(Buffer.alloc(0)),
      }),
    );
    const service = createKernelModuleService();
    try {
      const result = await service.inspect({ path });
      if (!result.ok) throw result.error;
      expect(result.value.normalized_result).toMatchObject({
        coverage: { status: "partial" },
        modinfo: {
          entries: expect.arrayContaining([
            expect.objectContaining({ key: "license", value: "GPL" }),
          ]),
        },
        signature: {
          status: "malformed",
          reason: "signature_length_inconsistent",
          magic: { bytes: 28 },
          info: { sig_len: 0, id_type: 2 },
          pkcs7: null,
        },
      });
    } finally {
      await service.close();
    }
  });

  it("reads module metadata and signature beyond the retained prefix", async () => {
    const root = await createTestTempDirectory("rea-kernel-module-positional-");
    const path = join(root, "demo.ko");
    // Enough section headers to place .modinfo and the signature beyond 4 KiB.
    const pkcs7 = Buffer.from("module signature outside prefix");
    const trailer = moduleSignatureTrailer(pkcs7);
    const bytes = kernelModuleFixture({
      sharedNameSections: { name: ".padding", count: 70 },
      signature: trailer,
    });
    const firstSection = Number(bytes.readBigUInt64LE(40)) + 64;
    const modinfoOffset = Number(bytes.readBigUInt64LE(firstSection + 24));
    const versionsOffset = Number(
      bytes.readBigUInt64LE(firstSection + 64 + 24),
    );
    expect(modinfoOffset).toBeGreaterThan(4096);
    expect(versionsOffset).toBeGreaterThan(4096);
    await writeFile(path, bytes);
    const service = createKernelModuleService();
    try {
      const result = await service.inspect({ path });
      if (!result.ok) throw result.error;
      expect(fileIdentity(result.value.subject)).toMatchObject({
        format: "elf",
        architecture: "x86_64",
      });
      expect(result.value.confidence).toBe("observed");
      const report = kernelModuleSchema.parse(result.value.normalized_result);
      expect(report.modinfo?.entries[0]).toMatchObject({
        key: "license",
        value: "GPL",
        location: { offset: modinfoOffset, bytes: 12 },
      });
      expect(report.versions?.location).toEqual({
        offset: versionsOffset,
        bytes: 128,
      });
      expect(report.versions?.entries[0]).toMatchObject({
        crc_hex: "0000000012345678",
        name: "printk",
        location: { offset: versionsOffset, bytes: 64 },
      });
      expect(report.signature).toMatchObject({
        status: "present",
        pkcs7: {
          location: {
            offset: bytes.length - trailer.length,
            bytes: pkcs7.length,
          },
          sha256: createHash("sha256").update(pkcs7).digest("hex"),
        },
      });
    } finally {
      await service.close();
    }
  });

  it("reports non-file and missing selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-kernel-module-files-");
    const path = join(root, "demo.ko");
    const alias = join(root, "alias");
    await writeFile(path, kernelModuleFixture());
    await symlink(path, alias);
    const service = createKernelModuleService();
    try {
      await expectFileSelectionErrors(service, "inspect_kernel_module", {
        root,
        alias,
        path,
      });
    } finally {
      await service.close();
    }
  });

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-kernel-module-budget-");
    const path = join(root, "demo.ko");
    await writeFile(path, kernelModuleFixture());
    const service = createKernelModuleService();
    try {
      const tooSmall = await service.inspect({ path, max_file_bytes: 64 });
      if (tooSmall.ok) throw new Error("Expected resource budget failure");
      expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
      const tooMany = await service.inspect({ path, max_entries: 1 });
      if (tooMany.ok) throw new Error("Expected entry budget failure");
      expect(tooMany.error._tag).toBe("AnalysisResourceConstraintError");
      const cancelled = await service.inspect(
        { path },
        { signal: AbortSignal.abort() },
      );
      if (cancelled.ok) throw new Error("Expected cancellation");
      expect(cancelled.error._tag).toBe("AnalysisCancelledError");
    } finally {
      await service.close();
    }
  });
});
