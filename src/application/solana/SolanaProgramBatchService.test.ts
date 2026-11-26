import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

import { SolanaProgramBatchService } from "./SolanaProgramBatchService.js";
import { SolanaProgramService } from "./SolanaProgramService.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { parseEvidence } from "../../domain/evidence.js";
import type { SolanaProgramBatch } from "../../domain/solana/solanaProgram.js";
import { SolanaProgramProvider } from "../../solana/SolanaProgramProvider.js";

/** Encode one sBPF word: opcode, register pair, i16 offset, i32 immediate. */
const word = (
  opcode: number,
  dst: number,
  src: number,
  offset: number,
  imm: number,
): Uint8Array => {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  bytes[0] = opcode;
  bytes[1] = dst | (src << 4);
  view.setInt16(2, offset, true);
  view.setInt32(4, imm, true);
  return bytes;
};

/**
 * Minimal valid sBPF ELF: header, one .text holding an lddw/jeq dispatch
 * (the create_config discriminator) and an exit, plus .shstrtab.
 */
const buildElf = (): Uint8Array => {
  const text = new Uint8Array(5 * 8);
  const words = [
    word(0x79, 3, 2, 0, 0),
    word(0x18, 4, 0, 0, 0x72f3cfc9),
    word(0x00, 0, 0, 0, 0xbd2f6f4b),
    word(0x1d, 3, 4, 5, 0),
    word(0x95, 0, 0, 0, 0),
  ];
  words.forEach((part, index) => text.set(part, index * 8));
  const shstrtab = new TextEncoder().encode("\0.text\0.shstrtab\0");
  const textOffset = 64;
  const shstrtabOffset = textOffset + text.length;
  const sectionHeaderOffset = shstrtabOffset + shstrtab.length;
  const bytes = new Uint8Array(sectionHeaderOffset + 3 * 64);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  view.setUint16(16, 3, true);
  view.setUint16(18, 263, true);
  view.setBigUint64(24, 0x100n, true);
  view.setBigUint64(40, BigInt(sectionHeaderOffset), true);
  view.setUint16(54, 56, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, 3, true);
  view.setUint16(62, 2, true);
  bytes.set(text, textOffset);
  bytes.set(shstrtab, shstrtabOffset);
  const section = (
    index: number,
    name: number,
    address: number,
    offset: number,
    size: number,
  ): void => {
    const base = sectionHeaderOffset + index * 64;
    view.setUint32(base, name, true);
    view.setUint32(base + 4, 1, true);
    view.setBigUint64(base + 8, 6n, true);
    view.setBigUint64(base + 16, BigInt(address), true);
    view.setBigUint64(base + 24, BigInt(offset), true);
    view.setBigUint64(base + 32, BigInt(size), true);
  };
  section(1, 1, 0x100, textOffset, text.length);
  section(2, 7, 0, shstrtabOffset, shstrtab.length);
  return bytes;
};

it("analyzes a mixed batch with per-item isolation and a written index", async () => {
  const root = await createTestTempDirectory("rea-solana-batch-");
  const elf = buildElf();
  const alphaPath = join(root, "alpha.so");
  const betaPath = join(root, "beta.so");
  const nestedDir = join(root, "nested");
  await mkdir(nestedDir);
  const nestedAlphaPath = join(nestedDir, "alpha.so");
  const missingPath = join(root, "missing.so");
  await writeFile(alphaPath, elf);
  await writeFile(betaPath, elf);
  await writeFile(nestedAlphaPath, elf);
  const outDir = join(root, "out");

  const provider = new SolanaProgramProvider();
  const single = await provider.analyze({ path: alphaPath });
  expect(single.ok).toBe(true);
  if (!single.ok) return;

  const batch = new SolanaProgramBatchService(
    new SolanaProgramService(provider),
  );
  const result = await batch.inspectBatch({
    items: [
      { path: alphaPath },
      { path: betaPath },
      { path: nestedAlphaPath },
      { path: missingPath },
    ],
    out_dir: outDir,
    concurrency: 2,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const evidence = parseEvidence(result.value);
  expect(evidence.operation).toBe("analyze_solana_programs");
  const summary = evidence.normalized_result as SolanaProgramBatch;
  expect(summary.total).toBe(4);
  expect(summary.succeeded).toBe(3);
  expect(summary.failed).toBe(1);
  expect(summary.entries.map((entry) => entry.name)).toEqual([
    "alpha",
    "beta",
    "alpha-2",
    "missing",
  ]);
  // Per-item results match single-mode analysis of the same file.
  expect(summary.entries[0]?.sha256).toBe(single.value.artifact.sha256);
  expect(summary.entries[0]?.handler_candidates).toBe(1);
  expect(summary.entries[0]?.dispatch?.by_method["lddw-compare"]).toBe(1);
  expect(summary.entries[0]?.slot).toBeNull();
  // The bad item is an error entry, not a failed batch.
  expect(summary.entries[3]?.status).toBe("error");
  expect(summary.entries[3]?.error).toBeTruthy();
  // index.json on disk carries exactly the Evidence entries.
  const index = JSON.parse(
    await readFile(join(outDir, "index.json"), "utf8"),
  ) as SolanaProgramBatch["entries"];
  expect(index).toEqual(summary.entries);
  // Per-item single-mode artifacts landed in each item directory.
  const itemAnalysis = JSON.parse(
    await readFile(join(outDir, "alpha", "solana-analysis.json"), "utf8"),
  ) as { artifact: { sha256: string } };
  expect(itemAnalysis.artifact.sha256).toBe(single.value.artifact.sha256);
});

it("rejects malformed batch input before analyzing anything", async () => {
  const batch = new SolanaProgramBatchService(
    new SolanaProgramService(new SolanaProgramProvider()),
  );
  const empty = await batch.inspectBatch({
    items: [],
    out_dir: "/tmp/rea-solana-batch-unused",
  });
  expect(empty.ok).toBe(false);
  const ambiguous = await batch.inspectBatch({
    items: [
      {
        path: "/tmp/a.so",
        program_id: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
      },
    ],
    out_dir: "/tmp/rea-solana-batch-unused",
  });
  expect(ambiguous.ok).toBe(false);
  const tooParallel = await batch.inspectBatch({
    items: [{ path: "/tmp/a.so" }],
    out_dir: "/tmp/rea-solana-batch-unused",
    concurrency: 9,
  });
  expect(tooParallel.ok).toBe(false);
});

const batchService = (): SolanaProgramBatchService =>
  new SolanaProgramBatchService(
    new SolanaProgramService(new SolanaProgramProvider()),
  );

it("keeps capture names that look like paths or reserved files inside out_dir", async () => {
  const root = await createTestTempDirectory("rea-solana-batch-names-");
  const elf = buildElf();
  const captures = join(root, "captures");
  await mkdir(captures);
  const dotted = join(captures, "...so");
  const reserved = join(captures, "index.json.so");
  await writeFile(dotted, elf);
  await writeFile(reserved, elf);
  const outDir = join(root, "out");
  const result = await batchService().inspectBatch({
    items: [{ path: dotted }, { path: reserved }],
    out_dir: outDir,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const summary = parseEvidence(result.value)
    .normalized_result as SolanaProgramBatch;
  for (const entry of summary.entries) {
    expect(entry.name).not.toMatch(/^[.-]|[/\\]/);
    expect(["index.json", "receipts.json"]).not.toContain(entry.name);
  }
  expect(await readdir(root)).toEqual(["captures", "out"]);
  const index = JSON.parse(
    await readFile(join(outDir, "index.json"), "utf8"),
  ) as SolanaProgramBatch["entries"];
  expect(index).toEqual(summary.entries);
});

it("expands a capture directory and reports an unreadable one as input", async () => {
  const root = await createTestTempDirectory("rea-solana-batch-dir-");
  const captures = join(root, "captures");
  await mkdir(captures);
  await writeFile(join(captures, "alpha.so"), buildElf());
  await writeFile(join(captures, "notes.txt"), "not a program");
  const expanded = await batchService().inspectBatch({
    dir: captures,
    out_dir: join(root, "out"),
  });
  expect(expanded.ok).toBe(true);
  if (!expanded.ok) return;
  const summary = parseEvidence(expanded.value)
    .normalized_result as SolanaProgramBatch;
  expect(summary.entries.map((entry) => entry.name)).toEqual(["alpha"]);

  const missing = await batchService().inspectBatch({
    dir: join(root, "absent"),
    out_dir: join(root, "out-missing"),
  });
  expect(missing.ok).toBe(false);
  if (missing.ok) return;
  expect(missing.error).toBeInstanceOf(AnalysisInputError);
  expect(missing.error.message).not.toMatch(/internal/i);
});

it("refuses a non-empty batch root instead of overwriting earlier output", async () => {
  const root = await createTestTempDirectory("rea-solana-batch-root-");
  const elfPath = join(root, "alpha.so");
  await writeFile(elfPath, buildElf());
  const outDir = join(root, "out");
  await mkdir(outDir);
  await writeFile(join(outDir, "index.json"), "[]");
  const result = await batchService().inspectBatch({
    items: [{ path: elfPath }],
    out_dir: outDir,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisInputError);
  expect(await readFile(join(outDir, "index.json"), "utf8")).toBe("[]");
});
