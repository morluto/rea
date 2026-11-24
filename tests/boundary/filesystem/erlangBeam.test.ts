import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBeamService } from "../../../src/composition/erlang.js";
import { erlangBeamFixture } from "../../../src/erlang/Beam.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("Erlang BEAM stable filesystem boundary", () => {
  it("reports non-file selections as caller input errors and malformed bytes as the target's", async () => {
    const root = await createTestTempDirectory("rea-beam-files-");
    const path = join(root, "app.beam");
    const alias = join(root, "alias.beam");
    const malformed = join(root, "malformed.beam");
    await writeFile(path, erlangBeamFixture());
    await writeFile(malformed, Buffer.from("not a beam"));
    await symlink(path, alias);
    const service = createBeamService();
    for (const [candidate, reason] of [
      [root, "invalid_format"],
      [alias, "invalid_format"],
      [join(root, "missing.beam"), "invalid_value"],
      [join(path, "child.beam"), "invalid_value"],
    ] as const) {
      const result = await service.inspect({ path: candidate });
      if (result.ok) throw new Error("Expected file acquisition failure");
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        operation: "inspect_erlang_beam",
        issues: [
          {
            path: ["path"],
            reason,
            message: expect.any(String),
          },
        ],
      });
    }
    const refused = await service.inspect({ path: malformed });
    if (refused.ok) throw new Error("Expected malformed target refusal");
    expect(refused.error).toMatchObject({
      _tag: "AnalysisTargetFailureError",
      operation: "inspect_erlang_beam",
      path: malformed,
      failure: {
        kind: "malformed",
        format: "beam",
        detail: "Expected a FOR1 IFF container.",
      },
    });
  });

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-beam-budget-");
    const path = join(root, "app.beam");
    await writeFile(path, erlangBeamFixture());
    const service = createBeamService();
    const tooSmall = await service.inspect({ path, max_file_bytes: 16 });
    if (tooSmall.ok) throw new Error("Expected resource budget failure");
    expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
    const reason = { source: "caller-request", operation: "cancel" };
    const cancelled = await service.inspect(
      { path: join(root, "missing.beam") },
      { signal: AbortSignal.abort(reason) },
    );
    if (cancelled.ok) throw new Error("Expected cancellation");
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
    expect(cancelled.error.cause).toBe(reason);
  });
});
