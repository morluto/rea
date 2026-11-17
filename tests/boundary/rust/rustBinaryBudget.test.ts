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
    limit: { parameter: "max_rustc_hashes", effective_value: 64 },
  });
  expect(result.value.auditable_metadata?.packages).toHaveLength(2);
  expect(result.value.limitations).toContainEqual(
    expect.stringContaining("rustc_commit.coverage.limit"),
  );
  // The producer names the contract field; the CLI renders its own option.
  expect(result.value.limitations.join(" ")).not.toContain("--");
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
      details: {
        reported_limits: { maximum_input_bytes: 4095 },
        limit: {
          control_kind: "parameter",
          parameter: "producer_limits.input_bytes",
          effective_value: 4095,
        },
      },
    });
    expect(projectedInput.remediation.action).not.toContain("--");
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
      details: {
        reported_limits: { maximum_output_bytes: 16 },
        limit: {
          control_kind: "parameter",
          parameter: "producer_limits.output_bytes",
          effective_value: 16,
        },
      },
    });
    expect(projectedReport.remediation.action).not.toContain("--");
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
    // Just below the smallest admitted budget, the dependency graph still
    // fits but the complete report does not.
    const inspectWithin = (output_bytes: number) =>
      provider.inspect({
        path,
        producer_limits: { input_bytes: 4096, output_bytes },
      });
    let refused = 16;
    let admitted = 16384;
    while (admitted - refused > 1) {
      const middle = Math.floor((refused + admitted) / 2);
      if ((await inspectWithin(middle)).ok) admitted = middle;
      else refused = middle;
    }
    const reportBytes = admitted;
    const tightReport = await inspectWithin(reportBytes - 1);
    if (tightReport.ok) throw new Error("Expected complete-report refusal");
    const projectedTight = projectAnalysisError(tightReport.error);
    expect(projectedTight).toMatchObject({
      code: "resource_constraint",
      message: expect.stringContaining("exceeds the inline output budget"),
      details: {
        reported_limits: { maximum_output_bytes: reportBytes - 1 },
        limit: {
          control_kind: "parameter",
          parameter: "producer_limits.output_bytes",
          effective_value: reportBytes - 1,
        },
      },
    });
    expect(projectedTight.remediation.action).not.toContain("--");
  } finally {
    await provider.close();
  }
});

it("describes compiler coverage from the retained result when report trimming drops every path", async () => {
  const root = await createTestTempDirectory("rea-rust-trimmed-guidance-");
  const path = join(root, "many-hashes.elf");
  await writeFile(path, createRustHashOverflowImage());
  const provider = new RustBinaryProvider();
  try {
    const inspect = (output_bytes: number) =>
      provider.inspect({ path, producer_limits: { output_bytes } });
    // The smallest admitted report keeps dependencies and no compiler path:
    // the reader's 64-path prefix is larger than the trimming guidance.
    let refused = 16;
    let admitted = 1024 * 1024;
    while (admitted - refused > 1) {
      const middle = Math.floor((refused + admitted) / 2);
      if ((await inspect(middle)).ok) admitted = middle;
      else refused = middle;
    }
    const trimmed = await inspect(admitted);
    if (!trimmed.ok) throw trimmed.error;
    expect(trimmed.value.rustc_commit).toBeNull();
    expect(trimmed.value.auditable_metadata?.packages).toHaveLength(2);
    const text = trimmed.value.limitations.join(" ");
    // The reader's partial-prefix guidance referred to a record that no
    // longer exists; the trimming guidance names its control directly.
    expect(text).not.toContain("rustc_commit.coverage.limit");
    expect(text).not.toContain("max_rustc_hashes=64");
    expect(text).toContain(
      "Compiler paths were omitted to preserve dependency facts",
    );
    expect(text).toContain("producer_limits.output_bytes");
    // The control that omitted every path stays recorded outside the
    // dropped compiler record, at a position the output schema declares.
    expect(trimmed.value.rustc_commit_omission).toEqual({
      reason: "report_bytes",
      limit: expect.objectContaining({
        control_kind: "parameter",
        parameter: "producer_limits.output_bytes",
        effective_value: admitted,
      }),
    });
  } finally {
    await provider.close();
  }
});

it("reports byte trimming only when it removes a compiler path", async () => {
  const root = await createTestTempDirectory("rea-rust-trim-window-");
  const path = join(root, "many-hashes.elf");
  await writeFile(path, createRustHashOverflowImage());
  const provider = new RustBinaryProvider();
  try {
    const inspect = (output_bytes: number) =>
      provider.inspect({ path, producer_limits: { output_bytes } });
    const complete = await inspect(1024 * 1024);
    if (!complete.ok) throw complete.error;
    const hashes = complete.value.rustc_commit?.hashes.length;
    expect(complete.value.rustc_commit?.coverage?.reason).toBe(
      "max_rustc_hashes",
    );
    const fullBytes = Buffer.byteLength(JSON.stringify(complete.value));
    // Below the complete report, swapping the reader's guidance for the
    // shorter trimming guidance can make every path fit again.
    let keptEveryPath = 0;
    for (let output = fullBytes - 1; output > fullBytes - 120; output -= 1) {
      const result = await inspect(output);
      if (!result.ok) continue;
      const commit = result.value.rustc_commit;
      if (commit === null) continue;
      const text = result.value.limitations.join(" ");
      if (commit.hashes.length === hashes) {
        keptEveryPath += 1;
        expect(commit, `output_bytes ${output}`).toEqual(
          complete.value.rustc_commit,
        );
        expect(text).not.toContain("Compiler paths were omitted");
      } else
        expect(commit.coverage?.reason, `output_bytes ${output}`).toBe(
          "report_bytes",
        );
    }
    expect(keptEveryPath).toBeGreaterThan(0);
  } finally {
    await provider.close();
  }
});
