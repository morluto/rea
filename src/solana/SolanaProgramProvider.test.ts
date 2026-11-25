import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisTargetFailureError,
} from "../domain/analysisErrorCore.js";
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
  const root = await mkdtemp(join(tmpdir(), "rea-solana-handoff-"));
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
  const root = await mkdtemp(join(tmpdir(), "rea-solana-handoff-"));
  const elfPath = join(root, "program.so");
  await writeFile(elfPath, buildElf());
  const provider = new SolanaProgramProvider();
  const result = await provider.analyze({ path: elfPath });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.handlers[0]?.name).toBeNull();
});

it("refuses an out_dir that already holds the capture and leaves it intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-solana-out-"));
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
  const root = await mkdtemp(join(tmpdir(), "rea-solana-out-"));
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
  const root = await mkdtemp(join(tmpdir(), "rea-solana-be-"));
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
  const root = await mkdtemp(join(tmpdir(), "rea-solana-trunc-"));
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
  const root = await mkdtemp(join(tmpdir(), "rea-solana-partial-"));
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

it("reports cancellation with the caller's reason instead of a provider failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-solana-abort-"));
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
