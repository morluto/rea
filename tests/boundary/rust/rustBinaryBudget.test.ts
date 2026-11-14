import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { RustBinaryProvider } from "../../../src/rust/RustBinaryProvider.js";
import {
  createRustImage,
  createRustHashOverflowImage,
} from "../../fixtures/rust/image.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("reports a recoverable compiler prefix without refusing the dependency report", async () => {
  const root = await createTestTempDirectory("rea-rust-hash-budget-");
  const path = join(root, "many-hashes.elf");
  await writeFile(path, createRustHashOverflowImage());
  const result = await new RustBinaryProvider().inspect({ path });
  if (!result.ok) throw result.error;
  expect(result.value.rustc_commit?.coverage).toMatchObject({
    reason: "max_rustc_hashes",
    effective_limit: 64,
  });
  expect(result.value.auditable_metadata?.packages).toHaveLength(2);
  expect(result.value.limitations).toContainEqual(
    expect.stringContaining("--max-rustc-hashes"),
  );
});

it("recovers the same complete Rust image after input and report budget changes", async () => {
  const root = await createTestTempDirectory("rea-rust-input-budget-");
  const path = join(root, "selected.elf");
  await writeFile(path, createRustImage({ format: "elf" }));
  const provider = new RustBinaryProvider();
  try {
    const smallInput = await provider.inspect({
      path,
      producer_limits: { input_bytes: 4095 },
    });
    if (smallInput.ok) throw new Error("Expected input admission refusal");
    const projectedInput = projectAnalysisError(smallInput.error);
    expect(projectedInput).toMatchObject({
      code: "resource_constraint",
      details: { reported_limits: { maximum_input_bytes: 4095 } },
    });
    expect(projectedInput.remediation.action).toContain(
      "producer_limits.input_bytes",
    );
    const smallReport = await provider.inspect({
      path,
      producer_limits: { input_bytes: 4096, output_bytes: 16 },
    });
    if (smallReport.ok) throw new Error("Expected report admission refusal");
    const projectedReport = projectAnalysisError(smallReport.error);
    expect(projectedReport).toMatchObject({
      code: "resource_constraint",
      details: { reported_limits: { maximum_output_bytes: 16 } },
    });
    expect(projectedReport.remediation.action).toContain(
      "producer_limits.output_bytes",
    );
    const recovered = await provider.inspect({
      path,
      producer_limits: { input_bytes: 4096, output_bytes: 16384 },
    });
    if (!recovered.ok) throw recovered.error;
    expect(recovered.value.auditable_metadata?.packages).toHaveLength(2);
    expect(recovered.value.artifact.bytes).toBe(4096);
  } finally {
    await provider.close();
  }
});
