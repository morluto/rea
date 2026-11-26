import { createHash } from "node:crypto";
import { symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPeOverlayService } from "../../../src/composition/binaryDiagnostics/peOverlay.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  MAX_INSPECT_PE_OVERLAY_FILE_BYTES,
  PE_OVERLAY_FILE_BYTES,
} from "../../../src/domain/native/peOverlay.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { peOverlayImage } from "../../../src/native/pe/PeOverlay.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("PE overlay stable filesystem boundary", () => {
  it("reports non-file and malformed PE selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-pe-overlay-files-");
    const path = join(root, "app.exe");
    const alias = join(root, "alias.exe");
    const malformed = join(root, "malformed.exe");
    await writeFile(path, peOverlayImage());
    await writeFile(malformed, Buffer.from("not a pe"));
    await symlink(path, alias);
    const service = createPeOverlayService();
    const malformedResult = await service.inspect({ path: malformed });
    if (malformedResult.ok)
      throw new Error("Expected malformed target refusal");
    expect(malformedResult.error).toMatchObject({
      _tag: "AnalysisTargetFailureError",
      operation: "inspect_pe_overlay",
      path: malformed,
      failure: expect.objectContaining({ kind: "malformed" }),
    });
    for (const [candidate, reason] of [
      [root, "invalid_format"],
      [alias, "invalid_format"],
      [join(root, "missing.exe"), "invalid_value"],
      [join(path, "child.exe"), "invalid_value"],
    ] as const) {
      const result = await service.inspect({ path: candidate });
      if (result.ok) throw new Error("Expected file acquisition failure");
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        operation: "inspect_pe_overlay",
        issues: [
          {
            path: ["path"],
            reason,
            message: expect.any(String),
          },
        ],
      });
    }
  });

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-pe-overlay-budget-");
    const path = join(root, "app.exe");
    const bytes = peOverlayImage();
    await writeFile(path, bytes);
    const service = createPeOverlayService();
    const tooSmall = await service.inspect({ path, max_file_bytes: 64 });
    if (tooSmall.ok) throw new Error("Expected resource budget failure");
    expect(tooSmall.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      operation: "inspect_pe_overlay",
      resource: "file-size",
      limit: {
        control_kind: "parameter",
        parameter: "max_file_bytes",
        effective_value: 64,
        required_value: bytes.length,
        unit: "bytes",
        minimum: PE_OVERLAY_FILE_BYTES.minimum,
        maximum: MAX_INSPECT_PE_OVERLAY_FILE_BYTES,
        default_value: PE_OVERLAY_FILE_BYTES.default_value,
        applies_at: "next_call",
      },
    });
    expect(projectAnalysisError(tooSmall.error)).toMatchObject({
      code: "resource_constraint",
      remediation: {
        action: expect.stringContaining(
          `at least ${String(bytes.length)} bytes`,
        ),
      },
      details: {
        limit: {
          control_kind: "parameter",
          parameter: "max_file_bytes",
          effective_value: 64,
          required_value: bytes.length,
        },
        refusal: {
          kind: "adjustable_budget",
          operation: "inspect_pe_overlay",
          control: "max_file_bytes",
          effective_value: 64,
          required_value: bytes.length,
          unit: "bytes",
          range: {
            minimum: PE_OVERLAY_FILE_BYTES.minimum,
            maximum: MAX_INSPECT_PE_OVERLAY_FILE_BYTES,
          },
          default_value: PE_OVERLAY_FILE_BYTES.default_value,
        },
      },
    });
    const cancelled = await service.inspect(
      { path },
      { signal: AbortSignal.abort() },
    );
    if (cancelled.ok) throw new Error("Expected cancellation");
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  });

  // Avoid reserving the file on filesystems without sparse truncation.
  it.skipIf(process.platform === "win32")(
    "reports when a file exceeds the max_file_bytes ceiling",
    async () => {
      const root = await createTestTempDirectory("rea-pe-overlay-ceiling-");
      const oversized = join(root, "oversized.exe");
      const oneGiB = 1024 * 1024 * 1024;
      await writeFile(oversized, Buffer.alloc(0));
      await truncate(oversized, oneGiB);
      const service = createPeOverlayService();
      const result = await service.inspect({ path: oversized });
      if (result.ok) throw new Error("Expected ceiling refusal");
      const projected = projectAnalysisError(result.error);
      expect(projected).toMatchObject({
        code: "resource_constraint",
        remediation: {
          action: expect.stringContaining(
            `requires ${String(oneGiB)} bytes, above the max_file_bytes maximum`,
          ),
        },
        details: {
          limit: {
            control_kind: "parameter",
            parameter: "max_file_bytes",
            effective_value: PE_OVERLAY_FILE_BYTES.default_value,
            required_value: oneGiB,
            maximum: MAX_INSPECT_PE_OVERLAY_FILE_BYTES,
          },
          refusal: {
            kind: "adjustable_budget",
            operation: "inspect_pe_overlay",
            control: "max_file_bytes",
            required_value: oneGiB,
          },
        },
      });
      expect(projected.remediation.action).not.toContain(
        "Pass a larger max_file_bytes",
      );
    },
  );

  it.each(["control", "close-failure", "close-cancel", "close-both"] as const)(
    "retains completed PE acquisition through %s",
    async (mode) => {
      const root = await createTestTempDirectory("rea-pe-overlay-finalize-");
      const path = join(root, "app.exe");
      const bytes = peOverlayImage();
      await writeFile(path, bytes);
      const controller = new AbortController();
      const reason = { request: "cancel during PE close" };
      const closeFailure = Object.assign(new Error("controlled PE close EIO"), {
        code: "EIO",
      });
      const original = OwnedFileHandle.prototype.close;
      let owner: OwnedFileHandle | undefined;
      const close = vi
        .spyOn(OwnedFileHandle.prototype, "close")
        .mockImplementationOnce(async function (this: OwnedFileHandle) {
          owner = this;
          if (mode === "close-cancel" || mode === "close-both")
            controller.abort(reason);
          if (mode === "close-failure" || mode === "close-both")
            throw closeFailure;
          await original.call(this);
        });
      const service = createPeOverlayService();
      try {
        const result = await service.inspect(
          { path },
          { signal: controller.signal },
        );
        if (mode === "control") {
          if (!result.ok) throw result.error;
          expect(result.value.normalized_result).toMatchObject({
            present: false,
            image_end: bytes.length,
            file_size: bytes.length,
          });
        } else {
          if (result.ok) throw new Error("Expected finalization failure");
          const acquired = {
            kind: "file-snapshot-hash",
            path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
          };
          expect(result.error.partialObservation).toEqual(acquired);
          expect(
            projectAnalysisError(result.error).details?.partial_observation,
          ).toEqual(acquired);
          const failedClose = mode === "close-failure" || mode === "close-both";
          expect(result.error.cleanupIncomplete).toBe(failedClose);
          if (failedClose) expect(owner?.handle.fd).toBeGreaterThanOrEqual(0);
          if (mode !== "close-failure") {
            const primary = result.error.cleanupPrimary ?? result.error;
            expect(primary).toMatchObject({
              _tag: "AnalysisCancelledError",
              cause: reason,
            });
          }
          close.mockRestore();
          await service.close();
          expect(result.error.cleanupIncomplete).toBe(false);
        }
        expect(owner?.handle.fd).toBe(-1);
      } finally {
        close.mockRestore();
        await service.close();
      }
    },
  );
});
