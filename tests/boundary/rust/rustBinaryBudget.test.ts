import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { RustBinaryProvider } from "../../../src/rust/RustBinaryProvider.js";
import {
  createRustImage,
  createRustHashOverflowImage,
  createWasmSectionFlood,
} from "../../fixtures/rust/image.js";
import { elfFrameAllowanceFixture } from "../../fixtures/binaryDiagnostics/elfFrameAllowance.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

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
    const commit = complete.value.rustc_commit;
    if (commit === null) throw new Error("Expected a compiler-path prefix");
    expect(commit.hashes).toHaveLength(64);
    expect(commit.coverage).toMatchObject({
      reason: "max_rustc_hashes",
      effective_limit: 64,
      limit: { parameter: "max_rustc_hashes", effective_value: 64 },
    });
    const guidance = complete.value.limitations.find((text) =>
      text.includes("rustc_commit.coverage.limit"),
    );
    if (guidance === undefined)
      throw new Error("Expected compiler-path guidance");
    expect(guidance).not.toContain("--max-rustc-hashes");
    expect(complete.value.auditable_metadata?.packages).toHaveLength(2);
    const fullBytes = Buffer.byteLength(JSON.stringify(complete.value));
    // Pick a budget halfway into the observed guidance's size. This leaves
    // room for the existing prefix even if the numeric budget's width changes.
    const tight = await inspect(
      fullBytes - Math.floor(Buffer.byteLength(JSON.stringify(guidance)) / 2),
    );
    if (!tight.ok) throw tight.error;
    expect(tight.value.rustc_commit).toEqual(commit);
    expect(tight.value.limitations).not.toContain(guidance);
    expect(tight.value).not.toHaveProperty("rustc_commit_omission");
    expect(tight.value.auditable_metadata).toEqual(
      complete.value.auditable_metadata,
    );

    const outputBytes =
      fullBytes - Math.floor(Buffer.byteLength(JSON.stringify(commit)) / 2);
    const trimmed = await inspect(outputBytes);
    if (!trimmed.ok) throw trimmed.error;
    const partial = trimmed.value.rustc_commit;
    if (partial === null)
      throw new Error("Expected some retained compiler paths");
    expect(partial.hashes.length).toBeLessThan(commit.hashes.length);
    expect(partial.hashes).toEqual(
      commit.hashes.slice(0, partial.hashes.length),
    );
    expect(partial.coverage).toMatchObject({
      status: "partial",
      reason: "report_bytes",
      effective_limit: outputBytes,
      limit: {
        parameter: "producer_limits.output_bytes",
        effective_value: outputBytes,
      },
    });
    expect(trimmed.value.auditable_metadata).toEqual(
      complete.value.auditable_metadata,
    );
  } finally {
    await provider.close();
  }
});

it("refuses dependency JSON at the binding parser budget and admits the measured compressed size", async () => {
  const root = await createTestTempDirectory("rea-rust-dependency-budget-");
  const path = join(root, "selected.elf");
  await writeFile(path, createRustImage({ format: "elf" }));
  const provider = new RustBinaryProvider();
  try {
    const compressed = await provider.inspect({
      path,
      max_compressed_dependency_bytes: 1,
    });
    if (compressed.ok)
      throw new Error("Expected the compressed-section refusal");
    const projected = projectAnalysisError(compressed.error);
    expect(projected).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      details: {
        resource: "memory",
        reported_limits: {
          boundary: "max_compressed_dependency_bytes",
          maximum: 1,
        },
        limit: {
          control_kind: "parameter",
          parameter: "max_compressed_dependency_bytes",
          effective_value: 1,
          unit: "bytes",
          minimum: 1,
          default_value: 1024 * 1024,
          applies_at: "next_call",
        },
        refusal: {
          kind: "adjustable_budget",
          operation: "inspect_rust_binary",
          control: "max_compressed_dependency_bytes",
          effective_value: 1,
          unit: "bytes",
          default_value: 1024 * 1024,
        },
      },
    });
    const reportedLimit = projected.details?.limit;
    const required =
      reportedLimit !== null &&
      typeof reportedLimit === "object" &&
      !Array.isArray(reportedLimit) &&
      typeof reportedLimit.required_value === "number"
        ? reportedLimit.required_value
        : undefined;
    if (required === undefined || required <= 1)
      throw new Error("Expected the measured compressed section size");
    const admitted = await provider.inspect({
      path,
      max_compressed_dependency_bytes: required,
    });
    if (!admitted.ok) throw admitted.error;
    expect(admitted.value.auditable_metadata?.packages.length).toBeGreaterThan(
      0,
    );

    const ratio = await provider.inspect({
      path,
      max_dependency_inflate_ratio: 1,
    });
    if (ratio.ok) throw new Error("Expected the inflate-ratio refusal");
    expect(projectAnalysisError(ratio.error).details).toMatchObject({
      limit: {
        parameter: "max_dependency_inflate_ratio",
        effective_value: 1,
        unit: "count",
        default_value: 64,
      },
      refusal: {
        kind: "adjustable_budget",
        control: "max_dependency_inflate_ratio",
      },
    });

    const inflated = await provider.inspect({
      path,
      max_inflated_dependency_bytes: 1,
    });
    if (inflated.ok) throw new Error("Expected the inflated-JSON refusal");
    expect(projectAnalysisError(inflated.error).details).toMatchObject({
      limit: {
        parameter: "max_inflated_dependency_bytes",
        effective_value: 1,
        default_value: 8 * 1024 * 1024,
      },
      refusal: {
        kind: "adjustable_budget",
        control: "max_inflated_dependency_bytes",
      },
    });
  } finally {
    await provider.close();
  }
});

it("cancels a many-frame compressed ELF section-name table", async () => {
  const root = await createTestTempDirectory("rea-rust-zstd-cancel-");
  const path = join(root, "app");
  await writeFile(path, elfFrameAllowanceFixture());
  const reason = new Error("stop rust frames");
  const controller = new AbortController();
  const yieldImpl = scheduler.yield.bind(scheduler);
  let yields = 0;
  const spy = vi.spyOn(scheduler, "yield").mockImplementation(async () => {
    yields += 1;
    await yieldImpl();
    if (yields === 1) controller.abort(reason);
  });
  try {
    const result = await new RustBinaryProvider().inspect(
      { path },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisCancelledError",
      operation: "inspect_rust_binary",
      cause: reason,
    });
  } finally {
    spy.mockRestore();
  }
});

it("names max_wasm_sections when a module has more sections than it", async () => {
  const root = await createTestTempDirectory("rea-rust-wasm-sections-");
  const path = join(root, "module.wasm");
  await writeFile(path, createWasmSectionFlood(8));
  const provider = new RustBinaryProvider();
  try {
    const refused = await provider.inspect({ path, max_wasm_sections: 4 });
    if (refused.ok) throw new Error("Expected a max_wasm_sections refusal");
    expect(projectAnalysisError(refused.error)).toMatchObject({
      code: "resource_constraint",
      details: {
        limit: {
          control_kind: "parameter",
          parameter: "max_wasm_sections",
          effective_value: 4,
          default_value: 65_536,
        },
        refusal: { kind: "adjustable_budget" },
      },
    });
    const admitted = await provider.inspect({ path, max_wasm_sections: 8 });
    if (!admitted.ok) throw admitted.error;
    expect(admitted.value.format).toBe("wasm");
  } finally {
    await provider.close();
  }
});
