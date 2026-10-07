import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { javascriptRecoveryResultSchema } from "../../../src/domain/javascriptRecovery.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  assertRecoveryCleanup,
  recoveryFixture,
} from "../../fixtures/javascript-recovery/provider.js";

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "Wakaru recovery boundary",
  () => {
    it("publishes exact bytes and mappings with source identity and no runtime-equivalence claim", async () => {
      const fixture = await recoveryFixture();
      const result = await fixture.service.recover({
        path: fixture.path,
        output_directory: fixture.output,
      });
      if (!result.ok) throw result.error;
      expect(parseEvidence(result.value)).toEqual(result.value);
      const value = javascriptRecoveryResultSchema.parse(
        result.value.normalized_result,
      );
      expect(value).toMatchObject({
        status: "complete",
        total: 1,
        failed: 0,
        runtime_equivalence: "unknown",
        analysis_input: {
          input_path: join(fixture.output, "modules"),
          format: "directory",
        },
      });
      expect(value.source.path).toBe(fixture.path);
      expect(value.source.published_copy.sha256).toBe(value.source.sha256);
      expect(value.modules[0]?.provenance.byte_ranges).toEqual([
        { start: 0, end: value.source.bytes },
      ]);
      expect(value.engine.executed_source_revision).toBeNull();
      expect(await readFile(value.source.published_copy.path, "utf8")).toBe(
        "module.exports = 42;",
      );
      expect(result.value.confidence).toBe("derived");
      await assertRecoveryCleanup(fixture.launches);
    });

    it.each([
      "missing-provenance",
      "malformed-report",
      "duplicate",
      "missing-file",
      "escaping",
      "extra-file",
      "symlink",
      "directory-symlink",
      "bad-map",
      "source-mismatch",
      "overflow-range",
      "extra-provenance",
      "snapshot-change",
      "source-change",
      "engine-change",
      "startup-error",
    ])(
      "rejects %s, rolls back publication and cleans its processes",
      async (mode) => {
        const fixture = await recoveryFixture(mode);
        const result = await fixture.service.recover({
          path: fixture.path,
          output_directory: fixture.output,
        });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected boundary failure");
        const error = projectAnalysisError(result.error);
        expect(["execution_failure", "unreadable_output"]).toContain(
          error.code,
        );
        expect(error.details).toBeDefined();
        await expect(access(fixture.output)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await assertRecoveryCleanup(fixture.launches);
      },
    );

    it("rejects byte ranges splitting a UTF-8 code point", async () => {
      const fixture = await recoveryFixture("utf8-range", "🎯");
      const result = await fixture.service.recover({
        path: fixture.path,
        output_directory: fixture.output,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected invalid UTF-8 boundary");
      expect(JSON.stringify(projectAnalysisError(result.error))).toContain(
        "UTF-8 byte range",
      );
      await assertRecoveryCleanup(fixture.launches);
    });

    it("retains valid partial output and exact failure diagnostics", async () => {
      const fixture = await recoveryFixture("partial");
      const result = await fixture.service.recover({
        path: fixture.path,
        output_directory: fixture.output,
      });
      if (!result.ok) throw result.error;
      const value = javascriptRecoveryResultSchema.parse(
        result.value.normalized_result,
      );
      expect(value).toMatchObject({
        status: "partial",
        failed: 1,
        warnings: [{ is_error: true, kind: "parse_error" }],
      });
      expect(value.modules).toHaveLength(1);
      await assertRecoveryCleanup(fixture.launches);
    });
  },
);

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "Wakaru recovery lifecycle",
  () => {
    it("rejects an existing output without modifying it or launching recovery", async () => {
      const fixture = await recoveryFixture();
      await mkdir(fixture.output);
      await writeFile(join(fixture.output, "keep.txt"), "keep");
      const result = await fixture.service.recover({
        path: fixture.path,
        output_directory: fixture.output,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected existing-output rejection");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "invalid_request",
        details: { issues: [{ path: ["output_directory"] }] },
      });
      expect(await readFile(join(fixture.output, "keep.txt"), "utf8")).toBe(
        "keep",
      );
      expect(fixture.launches).toHaveLength(0);
    });

    it("cancels an active recovery and verifies owned cleanup", async () => {
      const fixture = await recoveryFixture("hang");
      const controller = new AbortController();
      const resultPromise = fixture.service.recover(
        { path: fixture.path, output_directory: fixture.output },
        { signal: controller.signal },
      );
      const deadline = Date.now() + 10000;
      while (true) {
        const run = fixture.launches[1];
        if (
          run?.cwd !== undefined &&
          (await access(join(run.cwd, "recovery-started")).then(
            () => true,
            () => false,
          ))
        )
          break;
        if (Date.now() > deadline)
          throw new Error("fixture recovery did not start");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort();
      const result = await resultPromise;
      if (result.ok) throw new Error("expected cancellation");
      expect(projectAnalysisError(result.error).code).toBe("cancelled");
      await expect(access(fixture.output)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await assertRecoveryCleanup(fixture.launches);
    });

    it("reports cleanup failure and retains the workspace named by the error", async () => {
      const fixture = await recoveryFixture("cleanup-failure");
      const result = await fixture.service.recover({
        path: fixture.path,
        output_directory: fixture.output,
      });
      if (result.ok) throw new Error("expected cleanup failure");
      expect(projectAnalysisError(result.error).code).toBe(
        "cleanup_incomplete",
      );
      const launch = fixture.launches[0];
      if (launch?.cwd === undefined)
        throw new Error("missing process ownership");
      await expect(access(launch.cwd)).resolves.toBeUndefined();
      await expect(access(fixture.output)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("rejects an incompatible engine with its observed version", async () => {
      const fixture = await recoveryFixture("wrong-version");
      const result = await fixture.service.recover({
        path: fixture.path,
        output_directory: fixture.output,
      });
      if (result.ok) throw new Error("expected version failure");
      expect(JSON.stringify(projectAnalysisError(result.error))).toContain(
        "wakaru 0.0.0",
      );
      expect(projectAnalysisError(result.error).code).toBe(
        "capability_unavailable",
      );
      await assertRecoveryCleanup(fixture.launches);
    });
  },
);
