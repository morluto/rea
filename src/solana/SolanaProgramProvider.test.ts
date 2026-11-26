import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisTargetFailureError,
} from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { SafeOutputTree } from "../resources/index.js";
import { SolanaProgramProvider } from "./SolanaProgramProvider.js";
import type { SolanaHandoff } from "./SolanaHandoff.js";

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

/** Minimal sBPF ELF whose .text dispatches on the create_config discriminator. */
const buildElf = (): Uint8Array => {
  const text = new Uint8Array(5 * 8);
  [
    word(0x79, 3, 2, 0, 0),
    word(0x18, 4, 0, 0, 0x72f3cfc9),
    word(0x00, 0, 0, 0, 0xbd2f6f4b),
    word(0x1d, 3, 4, 5, 0),
    word(0x95, 0, 0, 0, 0),
  ].forEach((part, index) => text.set(part, index * 8));
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

it("writes a pinned handoff artifact with IDL-confirmed handler names", async () => {
  const root = await createTestTempDirectory("rea-solana-handoff-");
  const elf = buildElf();
  const elfPath = join(root, "program.so");
  await writeFile(elfPath, elf);
  const outDir = join(root, "out");
  const provider = new SolanaProgramProvider();
  const result = await provider.analyze({
    path: elfPath,
    out_dir: outDir,
    handoff: true,
    instruction_names: ["create_config", "nonexistent_ix"],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const report = result.value;
  // The supplied name confirmed the candidate; the bogus name changed nothing.
  expect(report.handlers).toHaveLength(1);
  expect(report.handlers[0]?.name).toBe("create_config");

  const handoffDir = join(outDir, "handoff");
  const copied = await readFile(join(handoffDir, "elf", "program.so"));
  expect(createHash("sha256").update(copied).digest("hex")).toBe(
    report.artifact.sha256,
  );
  expect(Buffer.compare(copied, Buffer.from(elf))).toBe(0);

  const handoff = JSON.parse(
    await readFile(join(handoffDir, "handoff.json"), "utf8"),
  ) as SolanaHandoff;
  expect(handoff.elf_sha256).toBe(report.artifact.sha256);
  expect(handoff.entrypoint).toBe(report.elf.entrypoint);
  expect(handoff.handlers).toHaveLength(1);
  expect(handoff.dispatch.total_candidates).toBe(1);
  expect(handoff.source_analysis_path).toBe(
    join(outDir, "solana-analysis.json"),
  );

  const brief = await readFile(join(handoffDir, "HANDOFF.md"), "utf8");
  expect(brief).toContain("IDL-confirmed handlers (1");
  expect(brief).toContain("`create_config`");
  expect(brief).toContain(report.artifact.sha256);
  expect(brief).toContain("Ghidra/IDA");
  expect(brief).toContain("differential-verify");
});

it("leaves handler names null when no instruction names are supplied", async () => {
  const root = await createTestTempDirectory("rea-solana-handoff-");
  const elfPath = join(root, "program.so");
  await writeFile(elfPath, buildElf());
  const provider = new SolanaProgramProvider();
  const result = await provider.analyze({ path: elfPath });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.handlers[0]?.name).toBeNull();
});

it("refuses an out_dir that already holds the capture and leaves it intact", async () => {
  const root = await createTestTempDirectory("rea-solana-out-");
  const elf = buildElf();
  // A capture named like an output file must never be overwritten.
  const elfPath = join(root, "solana-analysis.json");
  await writeFile(elfPath, elf);
  const result = await new SolanaProgramProvider().analyze({
    path: elfPath,
    out_dir: root,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisInputError);
  expect(Buffer.compare(await readFile(elfPath), Buffer.from(elf))).toBe(0);
  expect(await readdir(root)).toEqual(["solana-analysis.json"]);
});

it("keeps a capture named handoff.json distinct from the handoff metadata", async () => {
  const root = await createTestTempDirectory("rea-solana-out-");
  const elf = buildElf();
  const captureDir = join(root, "captures");
  await mkdir(captureDir);
  const elfPath = join(captureDir, "handoff.json");
  await writeFile(elfPath, elf);
  const outDir = join(root, "out");
  const result = await new SolanaProgramProvider().analyze({
    path: elfPath,
    out_dir: outDir,
    handoff: true,
  });
  expect(result.ok).toBe(true);
  const copy = await readFile(join(outDir, "handoff", "elf", "handoff.json"));
  expect(Buffer.compare(copy, Buffer.from(elf))).toBe(0);
  const metadata = JSON.parse(
    await readFile(join(outDir, "handoff", "handoff.json"), "utf8"),
  ) as SolanaHandoff;
  expect(metadata.elf_sha256).toBe(
    createHash("sha256").update(elf).digest("hex"),
  );
});

it("refuses a big-endian sBPF ELF instead of decoding it as little-endian", async () => {
  const root = await createTestTempDirectory("rea-solana-be-");
  const elf = buildElf();
  elf[5] = 2;
  const view = new DataView(elf.buffer);
  // Re-encode the header fields the parser reads in big-endian order.
  view.setUint16(16, 3, false);
  view.setUint16(18, 263, false);
  view.setBigUint64(32, 0n, false);
  view.setBigUint64(40, 0n, false);
  view.setUint16(54, 56, false);
  view.setUint16(56, 0, false);
  view.setUint16(58, 64, false);
  view.setUint16(60, 0, false);
  const elfPath = join(root, "be.so");
  await writeFile(elfPath, elf);
  const result = await new SolanaProgramProvider().analyze({ path: elfPath });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisTargetFailureError);
  expect((result.error as AnalysisTargetFailureError).failure.kind).toBe(
    "unsupported",
  );
});

it("refuses a code section that extends past the capture", async () => {
  const root = await createTestTempDirectory("rea-solana-trunc-");
  const elf = buildElf();
  const view = new DataView(elf.buffer);
  const sectionHeaderOffset = Number(view.getBigUint64(40, true));
  // Declare a .text size that runs past the end of the capture.
  view.setBigUint64(sectionHeaderOffset + 64 + 32, BigInt(elf.length), true);
  const elfPath = join(root, "truncated.so");
  await writeFile(elfPath, elf);
  const result = await new SolanaProgramProvider().analyze({ path: elfPath });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect((result.error as AnalysisTargetFailureError).failure.kind).toBe(
    "malformed",
  );
});

it("refuses a code section that ends inside an instruction", async () => {
  const root = await createTestTempDirectory("rea-solana-partial-");
  const elf = buildElf();
  const view = new DataView(elf.buffer);
  const sectionHeaderOffset = Number(view.getBigUint64(40, true));
  view.setBigUint64(sectionHeaderOffset + 64 + 32, 5n * 8n - 3n, true);
  const elfPath = join(root, "partial.so");
  await writeFile(elfPath, elf);
  const result = await new SolanaProgramProvider().analyze({ path: elfPath });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect((result.error as AnalysisTargetFailureError).failure.kind).toBe(
    "malformed",
  );
});

it("retains a tree whose rollback fails and releases it on close", async () => {
  const root = await createTestTempDirectory("rea-solana-cleanup-");
  const elfPath = join(root, "program.so");
  const outDir = join(root, "out");
  await writeFile(elfPath, buildElf());
  const provider = new SolanaProgramProvider();
  const writeSpy = vi
    .spyOn(SafeOutputTree.prototype, "write")
    .mockRejectedValueOnce(new Error("disk full"));
  const rollbackSpy = vi
    .spyOn(SafeOutputTree.prototype, "rollback")
    .mockRejectedValueOnce(new Error("handle busy"));
  try {
    const result = await provider.analyze({ path: elfPath, out_dir: outDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupResources).toContain(outDir);
    // The residual tree is still on disk, owned by the provider.
    await expect(stat(outDir)).resolves.toBeDefined();
  } finally {
    writeSpy.mockRestore();
    rollbackSpy.mockRestore();
  }
  // close() retries the retained rollback and releases the tree.
  await provider.close();
  await expect(stat(outDir)).rejects.toThrow();
});

it("binds a failed close retry error to the leases it retains", async () => {
  const root = await createTestTempDirectory("rea-solana-close-binding-");
  const elfPath = join(root, "program.so");
  const outDir = join(root, "out");
  await writeFile(elfPath, buildElf());
  const provider = new SolanaProgramProvider();
  const writeSpy = vi
    .spyOn(SafeOutputTree.prototype, "write")
    .mockRejectedValueOnce(new Error("disk full"));
  const rollbackSpy = vi
    .spyOn(SafeOutputTree.prototype, "rollback")
    .mockRejectedValueOnce(new Error("handle busy"))
    .mockRejectedValueOnce(new Error("still busy"));
  let retryError: unknown;
  try {
    const result = await provider.analyze({ path: elfPath, out_dir: outDir });
    expect(result.ok).toBe(false);
    retryError = await provider.close().then(
      () => undefined,
      (cause: unknown) => cause,
    );
  } finally {
    writeSpy.mockRestore();
    rollbackSpy.mockRestore();
  }
  expect(retryError).toBeInstanceOf(ProviderCleanupError);
  const failure = retryError as ProviderCleanupError;
  expect(failure.cleanupIncomplete).toBe(true);
  expect(failure.cleanupResources).toContain(outDir);
  // A later successful close releases the lease, and the same retry
  // error stops reporting incomplete cleanup.
  await provider.close();
  expect(failure.cleanupIncomplete).toBe(false);
  await expect(stat(outDir)).rejects.toThrow();
});

it("lists each distinct dynamic symbol name once in the report", async () => {
  const root = await createTestTempDirectory("rea-solana-symbol-names-");
  const elfPath = join(root, "program.so");
  // Three undefined symbols, two sharing one name: the report's name
  // inventory holds the name once, while the symbol count keeps all 3.
  const dynstr = new TextEncoder().encode("\0sol_log_\0sol_memcpy_\0");
  const headerSize = 64;
  const dynsymOffset = headerSize;
  const dynsymSize = 3 * 24;
  const dynstrOffset = dynsymOffset + dynsymSize;
  const shstrtab = new TextEncoder().encode("\0.dynsym\0.dynstr\0.shstrtab\0");
  const shstrtabOffset = dynstrOffset + dynstr.length;
  const sectionHeaderOffset = shstrtabOffset + shstrtab.length;
  const sectionCount = 4;
  const bytes = new Uint8Array(sectionHeaderOffset + sectionCount * 64);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  view.setUint16(16, 3, true);
  view.setUint16(18, 263, true);
  view.setBigUint64(40, BigInt(sectionHeaderOffset), true);
  view.setUint16(54, 56, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, sectionCount, true);
  view.setUint16(62, 3, true);
  [1, 1, 10].forEach((name, index) => {
    const offset = dynsymOffset + index * 24;
    view.setUint32(offset, name, true);
    bytes[offset + 4] = 0x10;
  });
  bytes.set(dynstr, dynstrOffset);
  bytes.set(shstrtab, shstrtabOffset);
  const section = (
    index: number,
    name: number,
    type: number,
    offset: number,
    size: number,
    link = 0,
    entrySize = 0,
  ): void => {
    const base = sectionHeaderOffset + index * 64;
    view.setUint32(base, name, true);
    view.setUint32(base + 4, type, true);
    view.setBigUint64(base + 24, BigInt(offset), true);
    view.setBigUint64(base + 32, BigInt(size), true);
    view.setUint32(base + 40, link, true);
    view.setBigUint64(base + 56, BigInt(entrySize), true);
  };
  section(1, 1, 11, dynsymOffset, dynsymSize, 2, 24);
  section(2, 9, 3, dynstrOffset, dynstr.length);
  section(3, 17, 3, shstrtabOffset, shstrtab.length);
  await writeFile(elfPath, bytes);
  const result = await new SolanaProgramProvider().analyze({ path: elfPath });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.syscalls.dynamic_symbols).toEqual([
    "sol_log_",
    "sol_memcpy_",
  ]);
  expect(result.value.syscalls.undefined_symbols).toBe(3);
});

it("reports cancellation with the caller's reason instead of a provider failure", async () => {
  const root = await createTestTempDirectory("rea-solana-abort-");
  const elfPath = join(root, "program.so");
  await writeFile(elfPath, buildElf());
  const controller = new AbortController();
  const reason = new Error("caller stopped");
  controller.abort(reason);
  const result = await new SolanaProgramProvider().analyze(
    { path: elfPath },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
});
