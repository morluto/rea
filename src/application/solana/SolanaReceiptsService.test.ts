import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

import { SolanaProgramBatchService } from "./SolanaProgramBatchService.js";
import { SolanaProgramService } from "./SolanaProgramService.js";
import { SolanaReceiptsService } from "./SolanaReceiptsService.js";
import { parseEvidence } from "../../domain/evidence.js";
import type {
  SolanaProgramReceipts,
  SolanaReceiptsResult,
} from "../../domain/solana/solanaReceipts.js";
import { SolanaProgramProvider } from "../../solana/SolanaProgramProvider.js";
import { SolanaReceiptsProvider } from "../../solana/SolanaReceiptsProvider.js";

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

/** Minimal sBPF ELF whose .text dispatches on one lddw discriminator. */
const buildElf = (lo: number, hi: number): Uint8Array => {
  const text = new Uint8Array(5 * 8);
  const words = [
    word(0x79, 3, 2, 0, 0),
    word(0x18, 4, 0, 0, lo),
    word(0x00, 0, 0, 0, hi),
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

/** create_config's discriminator c9cff3724b6f2fbd as lddw immediates. */
const CREATE_CONFIG_ELF = buildElf(0x72f3cfc9, 0xbd2f6f4b);
/** A second program whose only candidate is 0123456789abcdef. */
const OTHER_ELF = buildElf(0x67452301, 0xefcdab89);

const receiptsService = (): SolanaReceiptsService =>
  new SolanaReceiptsService(new SolanaReceiptsProvider());

const analyzeOne = async (elfPath: string, outDir: string): Promise<string> => {
  const service = new SolanaProgramService(new SolanaProgramProvider());
  const result = await service.inspect({
    path: elfPath,
    out_dir: outDir,
    instruction_names: ["create_config"],
  });
  expect(result.ok).toBe(true);
  const analysis = JSON.parse(
    await readFile(join(outDir, "solana-analysis.json"), "utf8"),
  ) as { artifact: { sha256: string } };
  return analysis.artifact.sha256;
};

it("receipts a single analysis from its evidence, bound by SHA-256", async () => {
  const root = await createTestTempDirectory("rea-solana-receipts-");
  const elfPath = join(root, "pump_amm.so");
  await writeFile(elfPath, CREATE_CONFIG_ELF);
  const outDir = join(root, "out");
  const sha = await analyzeOne(elfPath, outDir);
  const evidencePath = join(root, "evidence.json");
  await writeFile(
    evidencePath,
    JSON.stringify({
      program: { elf_sha256: sha },
      handlers: [
        {
          name: "create_config",
          verdict: "recovered",
          fixtures: { total: 6, passed: 6 },
          vm: "litesvm",
          evidence_refs: [
            "tx:2gNxbFQQmCsMaq7QYZkBxgeb2fcy5rsvQV9Mv9LzzoMtek9NbNWDzqqDcd4kfu8VeZFrf5FMqdeVw2YDpwJJYZTN",
          ],
        },
      ],
    }),
  );

  const result = await receiptsService().buildReceipts({
    out_dir: outDir,
    evidence_path: evidencePath,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const evidence = parseEvidence(result.value);
  expect(evidence.operation).toBe("solana_receipts");
  const built = evidence.normalized_result as SolanaReceiptsResult;
  expect(built.mode).toBe("single");
  expect(built.totals).toMatchObject({ recovered: 1, leads: 0 });
  // The written receipts.json is the per-program document, and the result
  // hashes exactly the bytes on disk.
  const onDisk = await readFile(join(outDir, "receipts.json"), "utf8");
  expect(createHash("sha256").update(onDisk).digest("hex")).toBe(
    built.receipts_sha256,
  );
  const doc = JSON.parse(onDisk) as SolanaProgramReceipts;
  expect(doc.program.elf_sha256).toBe(sha);
  expect(doc.receipts[0]?.verdict).toBe("recovered");
  expect(doc.receipts[0]?.name).toBe("create_config");
});

it("refuses evidence bound to a different artifact", async () => {
  const root = await createTestTempDirectory("rea-solana-receipts-");
  const elfPath = join(root, "pump_amm.so");
  await writeFile(elfPath, CREATE_CONFIG_ELF);
  const outDir = join(root, "out");
  await analyzeOne(elfPath, outDir);
  const evidencePath = join(root, "evidence.json");
  await writeFile(
    evidencePath,
    JSON.stringify({ program: { elf_sha256: "b".repeat(64) }, handlers: [] }),
  );
  const result = await receiptsService().buildReceipts({
    analysis_path: join(outDir, "solana-analysis.json"),
    evidence_path: evidencePath,
  });
  expect(result.ok).toBe(false);
});

it("receipts a batch, matching evidence per program and reporting orphan programs", async () => {
  const root = await createTestTempDirectory("rea-solana-receipts-");
  const alphaPath = join(root, "alpha.so");
  const betaPath = join(root, "beta.so");
  await writeFile(alphaPath, CREATE_CONFIG_ELF);
  await writeFile(betaPath, OTHER_ELF);
  const batchOut = join(root, "batch");
  const provider = new SolanaProgramProvider();
  const alpha = await provider.analyze({ path: alphaPath });
  expect(alpha.ok).toBe(true);
  if (!alpha.ok) return;
  const batch = new SolanaProgramBatchService(
    new SolanaProgramService(provider),
  );
  const batchResult = await batch.inspectBatch({
    items: [{ path: alphaPath }, { path: betaPath }],
    out_dir: batchOut,
    instruction_names: ["create_config"],
  });
  expect(batchResult.ok).toBe(true);

  const evidencePath = join(root, "evidence.json");
  await writeFile(
    evidencePath,
    JSON.stringify([
      {
        program: { elf_sha256: alpha.value.artifact.sha256 },
        handlers: [
          {
            discriminator: "c9cff3724b6f2fbd",
            verdict: "recovered",
            fixtures: { total: 6, passed: 6 },
            vm: "litesvm",
            evidence_refs: ["repro/pump_amm/create-config/"],
          },
        ],
      },
      { program: { elf_sha256: "c".repeat(64) }, handlers: [] },
    ]),
  );
  const result = await receiptsService().buildReceipts({
    out_dir: batchOut,
    evidence_path: evidencePath,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const built = parseEvidence(result.value)
    .normalized_result as SolanaReceiptsResult;
  expect(built.mode).toBe("batch");
  expect(built.programs).toHaveLength(2);
  expect(built.totals).toMatchObject({ recovered: 1, leads: 1 });
  expect(built.orphan_programs).toEqual(["c".repeat(64)]);
  // Per-item receipts plus the aggregate at the batch root.
  const alphaDoc = JSON.parse(
    await readFile(join(batchOut, "alpha", "receipts.json"), "utf8"),
  ) as SolanaProgramReceipts;
  expect(alphaDoc.receipts[0]?.verdict).toBe("recovered");
  const betaDoc = JSON.parse(
    await readFile(join(batchOut, "beta", "receipts.json"), "utf8"),
  ) as SolanaProgramReceipts;
  expect(betaDoc.receipts[0]?.verdict).toBe("lead");
  const rootDoc = JSON.parse(
    await readFile(join(batchOut, "receipts.json"), "utf8"),
  ) as { totals: SolanaReceiptsResult["totals"] };
  expect(rootDoc.totals.recovered).toBe(1);
});

it("rejects ambiguous or missing input before reading anything", async () => {
  const service = receiptsService();
  const both = await service.buildReceipts({
    analysis_path: "/tmp/a/solana-analysis.json",
    out_dir: "/tmp/a",
    evidence_path: "/tmp/e.json",
  });
  expect(both.ok).toBe(false);
  const noEvidence = await service.buildReceipts({ out_dir: "/tmp/a" });
  expect(noEvidence.ok).toBe(false);
  const missing = await service.buildReceipts({
    analysis_path: "/tmp/rea-solana-receipts-absent/solana-analysis.json",
    evidence_path: "/tmp/rea-solana-receipts-absent/evidence.json",
  });
  expect(missing.ok).toBe(false);
});

const batchOf = async (
  root: string,
  items: readonly { path: string }[],
): Promise<string> => {
  const batchOut = join(root, "batch");
  const batch = new SolanaProgramBatchService(
    new SolanaProgramService(new SolanaProgramProvider()),
  );
  const result = await batch.inspectBatch({
    items,
    out_dir: batchOut,
    instruction_names: ["create_config"],
  });
  expect(result.ok).toBe(true);
  return batchOut;
};

const sha256Of = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

it("derives receipt paths from out_dir, never from paths stored in the index", async () => {
  const root = await createTestTempDirectory("rea-solana-receipts-");
  const alphaPath = join(root, "alpha.so");
  await writeFile(alphaPath, CREATE_CONFIG_ELF);
  const batchOut = await batchOf(root, [{ path: alphaPath }]);
  const indexPath = join(batchOut, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    analysis_path?: string | null;
  }[];
  const elsewhere = await createTestTempDirectory("rea-solana-elsewhere-");
  for (const entry of index)
    if ("analysis_path" in entry)
      entry.analysis_path = join(elsewhere, "solana-analysis.json");
  await writeFile(indexPath, JSON.stringify(index));
  const evidencePath = join(root, "evidence.json");
  await writeFile(
    evidencePath,
    JSON.stringify({
      program: { elf_sha256: sha256Of(CREATE_CONFIG_ELF) },
      handlers: [],
    }),
  );
  const result = await receiptsService().buildReceipts({
    out_dir: batchOut,
    evidence_path: evidencePath,
  });
  expect(result.ok).toBe(true);
  expect(await readdir(elsewhere)).toEqual([]);
  await readFile(join(batchOut, "alpha", "receipts.json"), "utf8");
});

it("rejects duplicate evidence documents for one artifact", async () => {
  const root = await createTestTempDirectory("rea-solana-receipts-");
  const alphaPath = join(root, "alpha.so");
  await writeFile(alphaPath, CREATE_CONFIG_ELF);
  const batchOut = await batchOf(root, [{ path: alphaPath }]);
  const document = {
    program: { elf_sha256: sha256Of(CREATE_CONFIG_ELF) },
    handlers: [],
  };
  const evidencePath = join(root, "evidence.json");
  await writeFile(evidencePath, JSON.stringify([document, document]));
  const result = await receiptsService().buildReceipts({
    out_dir: batchOut,
    evidence_path: evidencePath,
  });
  expect(result.ok).toBe(false);
});

it("reports failed batch items as skipped with their recorded error", async () => {
  const root = await createTestTempDirectory("rea-solana-receipts-");
  const alphaPath = join(root, "alpha.so");
  await writeFile(alphaPath, CREATE_CONFIG_ELF);
  const batchOut = await batchOf(root, [
    { path: alphaPath },
    { path: join(root, "missing.so") },
  ]);
  const evidencePath = join(root, "evidence.json");
  await writeFile(
    evidencePath,
    JSON.stringify({
      program: { elf_sha256: sha256Of(CREATE_CONFIG_ELF) },
      handlers: [],
    }),
  );
  const result = await receiptsService().buildReceipts({
    out_dir: batchOut,
    evidence_path: evidencePath,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const built = parseEvidence(result.value)
    .normalized_result as SolanaReceiptsResult;
  expect(built.skipped_items.map((item) => item.name)).toEqual(["missing"]);
  expect(built.skipped_items[0]?.reason).toMatch(/Batch analysis failed/);
});

it("refuses to write receipts over a selected evidence file", async () => {
  const root = await createTestTempDirectory("rea-solana-receipts-");
  const elfPath = join(root, "program.so");
  await writeFile(elfPath, CREATE_CONFIG_ELF);
  const outDir = join(root, "out");
  const sha256 = await analyzeOne(elfPath, outDir);
  const evidencePath = join(outDir, "receipts.json");
  const evidence = JSON.stringify({
    program: { elf_sha256: sha256 },
    handlers: [],
  });
  await writeFile(evidencePath, evidence);
  const result = await receiptsService().buildReceipts({
    out_dir: outDir,
    evidence_path: evidencePath,
  });
  expect(result.ok).toBe(false);
  expect(await readFile(evidencePath, "utf8")).toBe(evidence);
});
