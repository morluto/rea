import { createHash } from "node:crypto";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPeCertificatesService } from "../../../src/composition/binaryDiagnostics/peCertificates.js";
import { peCertificateFixture } from "../../../src/native/pe/PeCertificates.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { expectFileSelectionErrors } from "../../support/expectFileSelectionErrors.js";

describe("PE certificate stable filesystem boundary", () => {
  it("reports non-file and missing selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-pe-cert-files-");
    const path = join(root, "signed.exe");
    const alias = join(root, "alias.exe");
    await writeFile(path, peCertificateFixture());
    await symlink(path, alias);
    const service = createPeCertificatesService();
    await expectFileSelectionErrors(
      service,
      "inspect_pe_certificates",
      { root, alias, path },
      ".exe",
    );
  });

  // The certificate table body is the target's own structure: a header that
  // declares less than itself is malformed bytes, not a selection error, and
  // the refusal names the exact snapshot it read.
  it("refuses a malformed certificate table body as the target's fault", async () => {
    const root = await createTestTempDirectory("rea-pe-cert-body-");
    const path = join(root, "signed.exe");
    const bytes = peCertificateFixture();
    bytes.writeUInt32LE(4, bytes.readUInt32LE(0x98 + 96 + 4 * 8));
    await writeFile(path, bytes);
    const result = await createPeCertificatesService().inspect({ path });
    if (result.ok) throw new Error("Expected malformed target refusal");
    expect(result.error).toMatchObject({
      _tag: "AnalysisMalformedTargetError",
      operation: "inspect_pe_certificates",
      path,
      failure: { kind: "malformed", format: "pe-certificate-table" },
      partialObservation: {
        kind: "file-snapshot-hash",
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
  });

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-pe-cert-budget-");
    const path = join(root, "signed.exe");
    const bytes = peCertificateFixture();
    await writeFile(path, bytes);
    const service = createPeCertificatesService();
    const tooSmall = await service.inspect({ path, max_file_bytes: 64 });
    if (tooSmall.ok) throw new Error("Expected resource budget failure");
    expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
    const cancelled = await service.inspect(
      { path },
      { signal: AbortSignal.abort() },
    );
    if (cancelled.ok) throw new Error("Expected cancellation");
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  });
});
