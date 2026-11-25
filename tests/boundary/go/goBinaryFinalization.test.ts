import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { GoBinaryProvider } from "../../../src/go/GoBinaryProvider.js";
import { GoBinaryService } from "../../../src/application/go/GoBinaryService.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createGoBinaryFixture } from "../../fixtures/go/image.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["control", "close-failure", "close-cancel", "close-both"] as const)(
  "retains completed Go acquisition through %s",
  async (mode) => {
    const root = await createTestTempDirectory("rea-go-finalization-");
    const path = join(root, "selected.elf");
    const { bytes, headerOffset, versionOffset } = createGoBinaryFixture();
    await writeFile(path, bytes);
    const controller = new AbortController();
    const reason = { request: "cancel during Go close" };
    const closeFailure = Object.assign(new Error("controlled Go close EIO"), {
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
    const service = new GoBinaryService(new GoBinaryProvider());
    const parameters = { path, max_input_bytes: bytes.length + 64 };
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      const result = await service.inspect(parameters, {
        signal: controller.signal,
      });
      expect(result.ok).toBe(mode === "control");
      const evidence = result.ok
        ? result.value
        : parseEvidence(result.error.partialObservation);
      expect(evidence).toMatchObject({
        operation: "inspect_go_binary",
        locations: [
          { kind: "artifact-path", path },
          {
            kind: "file-offset-range",
            start: headerOffset,
            end: headerOffset + 32,
          },
        ],
        subject: { identity: { format: "elf", sha256 }, local_path: path },
        normalized_result: {
          artifact: { path, sha256, bytes: bytes.length },
          build_info: {
            go_version: "go1.26.0",
            header_offset: headerOffset,
            version_location: { offset: versionOffset, bytes: 8 },
          },
        },
      });
      expect(evidence.parameters).toEqual(parameters);
      if (!result.ok) {
        const partial = result.error.partialObservation;
        const primary = result.error.cleanupPrimary ?? result.error;
        expect(
          projectAnalysisError(result.error).details?.partial_observation,
        ).toEqual(evidence);
        expect(primary.partialObservation).toBe(partial);
        const failedClose = mode === "close-failure" || mode === "close-both";
        expect(result.error.cleanupIncomplete).toBe(failedClose);
        if (failedClose) expect(owner?.handle.fd).toBeGreaterThanOrEqual(0);
        else expect(owner?.handle.fd).toBe(-1);
        if (mode !== "close-failure") {
          expect(primary).toMatchObject({
            _tag: "AnalysisCancelledError",
            cause: reason,
          });
          expect(primary.cause).toBe(reason);
        }
        close.mockRestore();
        await service.close();
        expect(result.error.cleanupIncomplete).toBe(false);
        expect(primary.partialObservation).toBe(partial);
      }
      expect(owner?.handle.fd).toBe(-1);
    } finally {
      close.mockRestore();
      await service.close();
    }
  },
);
