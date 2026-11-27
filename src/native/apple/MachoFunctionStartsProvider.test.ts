import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createMachoFunctionStartsService } from "../../composition/binaryDiagnostics/machoFunctionStarts.js";
import { AnalysisTargetFailureError } from "../../domain/analysisErrorCore.js";
import { inspectMachoFunctionStartsInputSchema } from "../../domain/native/machoFunctionStarts.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  arm64FunctionStartsImage,
  machoFunctionStartsUniversal,
  x64FunctionStartsImage,
} from "./MachoFunctionStarts.fixture.js";
import { MachoFunctionStartsProvider } from "./MachoFunctionStartsProvider.js";

const inspect = async (bytes: Buffer, input: Record<string, unknown> = {}) => {
  const path = join(
    await createTestTempDirectory("rea-macho-function-starts-"),
    "program",
  );
  await writeFile(path, bytes);
  const provider = new MachoFunctionStartsProvider();
  try {
    return await provider.inspect(
      inspectMachoFunctionStartsInputSchema.parse({ path, ...input }),
    );
  } finally {
    await provider.close();
  }
};

describe("Mach-O function starts provider", () => {
  it("refuses max_entries at the allowance without claiming a total", async () => {
    const refused = await inspect(arm64FunctionStartsImage(), {
      max_entries: 5,
    });
    if (refused.ok) throw new Error("Expected a max_entries refusal");
    expect(refused.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      limit: {
        control_kind: "parameter",
        parameter: "max_entries",
        effective_value: 5,
        default_value: 2_097_152,
      },
    });
    // Decoding stopped at the allowance, so the total was not measured.
    expect(
      (refused.error as { readonly limit?: object }).limit,
    ).not.toHaveProperty("required_value");
  });

  it("rejects architecture on a thin image and a universal file without one", async () => {
    const thin = await inspect(arm64FunctionStartsImage(), {
      architecture: "arm64",
    });
    if (thin.ok) throw new Error("Expected a thin-image architecture refusal");
    expect(thin.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [{ path: ["architecture"] }],
    });
    const universal = await inspect(
      machoFunctionStartsUniversal(
        arm64FunctionStartsImage(),
        x64FunctionStartsImage(),
      ),
    );
    if (universal.ok)
      throw new Error("Expected a missing architecture refusal");
    expect(universal.error._tag).toBe("AnalysisInputError");
  });

  it("reports bytes that are not Mach-O as a target failure", async () => {
    const foreign = await inspect(
      Buffer.from("not a macho image, just text!!"),
    );
    if (foreign.ok) throw new Error("Expected a target failure");
    expect(foreign.error).toBeInstanceOf(AnalysisTargetFailureError);
    expect(foreign.error._tag).toBe("AnalysisTargetFailureError");
    expect(foreign.error).toMatchObject({
      failure: { kind: "unrecognized", format: "macho" },
    });
  });

  it("reports an ELF file as unrecognized, not as a malformed Mach-O", async () => {
    const elf = Buffer.alloc(64);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(elf);
    const refused = await inspect(elf);
    if (refused.ok) throw new Error("Expected a target failure");
    expect(refused.error).toMatchObject({
      _tag: "AnalysisTargetFailureError",
      failure: { kind: "unrecognized", format: "macho" },
    });
  });

  it("keeps a recognized but cut-off Mach-O header a format failure", async () => {
    // A 64-bit Mach-O magic with the header cut off after 12 bytes.
    const cut = arm64FunctionStartsImage().subarray(0, 12);
    const refused = await inspect(Buffer.from(cut));
    if (refused.ok) throw new Error("Expected a target failure");
    expect(refused.error._tag).toBe("AnalysisTargetFailureError");
    expect((refused.error as AnalysisTargetFailureError).failure.kind).not.toBe(
      "unrecognized",
    );
  });
});

describe("Mach-O function starts service failures", () => {
  it("returns typed resource and cancellation failures", async () => {
    const path = join(
      await createTestTempDirectory("rea-macho-function-starts-budget-"),
      "program",
    );
    await writeFile(path, arm64FunctionStartsImage());
    const service = createMachoFunctionStartsService();
    try {
      const tooSmall = await service.inspect({ path, max_file_bytes: 64 });
      if (tooSmall.ok) throw new Error("Expected resource budget failure");
      expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
      expect(tooSmall.error).toMatchObject({
        resource: "capacity",
        limit: { parameter: "max_file_bytes" },
      });
      const paddedPath = join(
        await createTestTempDirectory("rea-macho-function-starts-padded-"),
        "padded",
      );
      await writeFile(
        paddedPath,
        Buffer.concat([arm64FunctionStartsImage(), Buffer.alloc(131_072)]),
      );
      const fitsReadBudget = await service.inspect({
        path: paddedPath,
        max_file_bytes: 80_000,
      });
      expect(fitsReadBudget.ok).toBe(true);
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
