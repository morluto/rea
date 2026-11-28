import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createBinaryHardeningService } from "../../../src/composition/binaryDiagnostics/binaryHardening.js";
import {
  elfHardeningFixture,
  machoHardeningFixture,
} from "../../../src/native/hardening/BinaryHardening.fixture.js";
import { elfFrameAllowanceFixture } from "../../fixtures/binaryDiagnostics/elfFrameAllowance.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { expectFileSelectionErrors } from "../../support/expectFileSelectionErrors.js";

describe("binary hardening stable filesystem boundary", () => {
  it("reports non-file and missing selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-binary-hardening-files-");
    const path = join(root, "app");
    const alias = join(root, "alias");
    const bytes = elfHardeningFixture();
    await writeFile(path, bytes);
    await symlink(path, alias);
    const service = createBinaryHardeningService();
    try {
      await expectFileSelectionErrors(service, "inspect_binary_hardening", {
        root,
        alias,
        path,
      });
      const foreign = join(root, "foreign");
      await writeFile(foreign, Buffer.from("not a binary"));
      const unsupported = await service.inspect({ path: foreign });
      if (unsupported.ok) throw new Error("Expected an unsupported target");
      expect(unsupported.error._tag).toBe("AnalysisTargetFailureError");
    } finally {
      await service.close();
    }
  });

  it("returns typed resource and cancellation failures and leaves bytes unchanged", async () => {
    const root = await createTestTempDirectory("rea-binary-hardening-budget-");
    const path = join(root, "app");
    const bytes = elfHardeningFixture();
    await writeFile(path, bytes);
    const service = createBinaryHardeningService();
    try {
      const tooSmall = await service.inspect({ path, max_file_bytes: 64 });
      if (tooSmall.ok) throw new Error("Expected resource budget failure");
      expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
      const cancelled = await service.inspect(
        { path },
        { signal: AbortSignal.abort() },
      );
      if (cancelled.ok) throw new Error("Expected cancellation");
      expect(cancelled.error._tag).toBe("AnalysisCancelledError");
      const result = await service.inspect({ path });
      if (!result.ok) throw result.error;
      expect(result.value.normalized_result).toMatchObject({
        format: "elf",
        images: [{ status: "parsed", architecture: "x86_64" }],
      });
      expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
    } finally {
      await service.close();
    }
  });

  it("reports structured max_table_entries details.limit on dynamic-table refusal and accepts raised budget", async () => {
    const root = await createTestTempDirectory("rea-binary-hardening-entries-");
    const path = join(root, "app");
    // A file-backed PT_DYNAMIC of 65,537 entries (16 bytes each in ELF64).
    const fixture = elfHardeningFixture();
    const bytes = Buffer.concat([fixture, Buffer.alloc(65_537 * 16)]);
    const programs = Number(bytes.readBigUInt64LE(32));
    const dynamic = Array.from(
      { length: bytes.readUInt16LE(56) },
      (_, index) => programs + index * bytes.readUInt16LE(54),
    ).find((at) => bytes.readUInt32LE(at) === 2);
    if (dynamic === undefined) throw new Error("Fixture has no PT_DYNAMIC");
    bytes.writeBigUInt64LE(BigInt(fixture.length), dynamic + 8);
    bytes.writeBigUInt64LE(65_537n * 16n, dynamic + 32);
    await writeFile(path, bytes);
    const service = createBinaryHardeningService();
    try {
      const result = await service.inspect({ path });
      if (result.ok) throw new Error("Expected the entry allowance refusal");
      expect(result.error).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
        limit: {
          control_kind: "parameter",
          parameter: "max_table_entries",
          effective_value: 65_536,
          required_value: 65_537,
          minimum: 1,
          maximum: 1_048_576,
          default_value: 65_536,
          unit: "count",
          applies_at: "next_call",
        },
      });
      const raised = await service.inspect({
        path,
        max_table_entries: 65_537,
      });
      expect(raised.ok).toBe(true);
    } finally {
      await service.close();
    }
  });

  it("threads max_table_entries to Mach-O LC_SYMTAB and streams DT_GNU_HASH without over-reading max_file_bytes", async () => {
    const root = await createTestTempDirectory("rea-binary-hardening-sym-");
    const machoPath = join(root, "macho");
    await writeFile(
      machoPath,
      machoHardeningFixture({ stackChk: true, nsyms: 3 }),
    );
    const service = createBinaryHardeningService();
    try {
      const tight = await service.inspect({
        path: machoPath,
        max_table_entries: 1,
      });
      if (!tight.ok) throw tight.error;
      const tightRows = (
        tight.value.normalized_result as {
          images: {
            rows: { property: string; state: string; note: string | null }[];
          }[];
        }
      ).images[0]!.rows;
      expect(
        tightRows.find((row) => row.property === "stack_protector"),
      ).toMatchObject({
        state: "unknown",
        note: expect.stringContaining("max_table_entries"),
      });

      const raised = await service.inspect({
        path: machoPath,
        max_table_entries: 4,
      });
      if (!raised.ok) throw raised.error;
      const raisedRows = (
        raised.value.normalized_result as {
          images: { rows: { property: string; state: string }[] }[];
        }
      ).images[0]!.rows;
      expect(
        raisedRows.find((row) => row.property === "stack_protector")?.state,
      ).toBe("enabled");

      // Build a 5 MiB ELF64 with a 32-byte DT_GNU_HASH table inside its PT_LOAD
      // and verify raising max_table_entries to 500,000 does not trigger a 2 MiB
      // speculative read against a 1 MiB max_file_bytes budget.
      const base = elfHardeningFixture({ stackChk: true, sections: false });
      const padded = Buffer.concat([base, Buffer.alloc(5 * 1024 * 1024)]);
      const phoff = Number(padded.readBigUInt64LE(32));
      const phentsize = padded.readUInt16LE(54);
      const phnum = padded.readUInt16LE(56);
      let dynamicOffset = 0;
      let dynamicSize = 0;
      let loadVaddr = 0n;
      let loadOffset = 0;
      for (let i = 0; i < phnum; i += 1) {
        const at = phoff + i * phentsize;
        const type = padded.readUInt32LE(at);
        if (type === 1) {
          loadOffset = Number(padded.readBigUInt64LE(at + 8));
          loadVaddr = padded.readBigUInt64LE(at + 16);
          const span = BigInt(padded.length - loadOffset);
          padded.writeBigUInt64LE(span, at + 32);
          padded.writeBigUInt64LE(span, at + 40);
        } else if (type === 2) {
          dynamicOffset = Number(padded.readBigUInt64LE(at + 8));
          dynamicSize = Number(padded.readBigUInt64LE(at + 32));
        }
      }
      const gnuHashOffset = base.length;
      const gnuHashVaddr = loadVaddr + BigInt(gnuHashOffset - loadOffset);
      // buckets=1, firstSymbol=1, bloomWords=1, bloomShift=0, bloom[0]=0, bucket[0]=1, chain[0]=1 (end)
      padded.writeUInt32LE(1, gnuHashOffset);
      padded.writeUInt32LE(1, gnuHashOffset + 4);
      padded.writeUInt32LE(1, gnuHashOffset + 8);
      padded.writeUInt32LE(0, gnuHashOffset + 12);
      padded.writeBigUInt64LE(0n, gnuHashOffset + 16);
      padded.writeUInt32LE(1, gnuHashOffset + 24);
      padded.writeUInt32LE(1, gnuHashOffset + 28);
      for (
        let off = dynamicOffset;
        off < dynamicOffset + dynamicSize;
        off += 16
      ) {
        if (padded.readBigUInt64LE(off) === 4n) {
          padded.writeBigUInt64LE(0x6ffffef5n, off);
          padded.writeBigUInt64LE(gnuHashVaddr, off + 8);
          break;
        }
      }
      const gnuPath = join(root, "gnu-hash-5m");
      await writeFile(gnuPath, padded);
      const bigBudget = await service.inspect({
        path: gnuPath,
        max_file_bytes: 1_048_576,
        max_table_entries: 500_000,
      });
      if (!bigBudget.ok) throw bigBudget.error;
      const gnuRows = (
        bigBudget.value.normalized_result as {
          images: { rows: { property: string; state: string }[] }[];
        }
      ).images[0]!.rows;
      expect(
        gnuRows.find((row) => row.property === "stack_protector")?.state,
      ).toBe("enabled");

      // Multi-bucket DT_GNU_HASH must not double-read 64 KiB windows because
      // of the end-of-buckets bounds probe: an 87 KiB ELF fits a 100 KiB
      // max_file_bytes budget.
      const multiBucketBase = elfHardeningFixture({
        stackChk: true,
        sections: false,
      });
      const multiBucket = Buffer.concat([
        multiBucketBase,
        Buffer.alloc(85 * 1024),
      ]);
      const mbPhoff = Number(multiBucket.readBigUInt64LE(32));
      const mbPhentsize = multiBucket.readUInt16LE(54);
      const mbPhnum = multiBucket.readUInt16LE(56);
      let mbDynOffset = 0;
      let mbDynSize = 0;
      let mbLoadVaddr = 0n;
      let mbLoadOffset = 0;
      for (let i = 0; i < mbPhnum; i += 1) {
        const at = mbPhoff + i * mbPhentsize;
        const type = multiBucket.readUInt32LE(at);
        if (type === 1) {
          mbLoadOffset = Number(multiBucket.readBigUInt64LE(at + 8));
          mbLoadVaddr = multiBucket.readBigUInt64LE(at + 16);
          const span = BigInt(multiBucket.length - mbLoadOffset);
          multiBucket.writeBigUInt64LE(span, at + 32);
          multiBucket.writeBigUInt64LE(span, at + 40);
        } else if (type === 2) {
          mbDynOffset = Number(multiBucket.readBigUInt64LE(at + 8));
          mbDynSize = Number(multiBucket.readBigUInt64LE(at + 32));
        }
      }
      const mbHashOffset = multiBucketBase.length;
      const mbHashVaddr = mbLoadVaddr + BigInt(mbHashOffset - mbLoadOffset);
      // buckets=2, firstSymbol=1, bloomWords=1, bloomShift=0, bloom[0]=0,
      // buckets=[0, 1], chain[0]=1 (end).
      multiBucket.writeUInt32LE(2, mbHashOffset);
      multiBucket.writeUInt32LE(1, mbHashOffset + 4);
      multiBucket.writeUInt32LE(1, mbHashOffset + 8);
      multiBucket.writeUInt32LE(0, mbHashOffset + 12);
      multiBucket.writeBigUInt64LE(0n, mbHashOffset + 16);
      multiBucket.writeUInt32LE(0, mbHashOffset + 24);
      multiBucket.writeUInt32LE(1, mbHashOffset + 28);
      multiBucket.writeUInt32LE(1, mbHashOffset + 32);
      for (let off = mbDynOffset; off < mbDynOffset + mbDynSize; off += 16) {
        if (multiBucket.readBigUInt64LE(off) === 4n) {
          multiBucket.writeBigUInt64LE(0x6ffffef5n, off);
          multiBucket.writeBigUInt64LE(mbHashVaddr, off + 8);
          break;
        }
      }
      const mbPath = join(root, "gnu-hash-multi-bucket");
      await writeFile(mbPath, multiBucket);
      const mbRes = await service.inspect({
        path: mbPath,
        max_file_bytes: 100_000,
      });
      if (!mbRes.ok) throw mbRes.error;
      const mbRows = (
        mbRes.value.normalized_result as {
          images: { rows: { property: string; state: string }[] }[];
        }
      ).images[0]!.rows;
      expect(
        mbRows.find((row) => row.property === "stack_protector")?.state,
      ).toBe("enabled");

      // firstSymbol > max_table_entries must degrade cleanly without over-reading.
      padded.writeUInt32LE(700_000, gnuHashOffset + 4);
      const overFirstPath = join(root, "gnu-hash-first-over");
      await writeFile(overFirstPath, padded);
      const degradedGnu = await service.inspect({
        path: overFirstPath,
        max_file_bytes: 1_048_576,
        max_table_entries: 500_000,
      });
      if (!degradedGnu.ok) throw degradedGnu.error;
      const degradedRows = (
        degradedGnu.value.normalized_result as {
          images: {
            rows: { property: string; state: string; note: string | null }[];
          }[];
        }
      ).images[0]!.rows;
      expect(
        degradedRows.find((row) => row.property === "stack_protector"),
      ).toMatchObject({
        state: "unknown",
        note: expect.stringContaining("max_table_entries"),
      });
    } finally {
      await service.close();
    }
  });
});

describe("binary hardening compressed ELF names", () => {
  it("cancels a many-frame compressed section-name table", async () => {
    const root = await createTestTempDirectory("rea-binary-hardening-cancel-");
    const path = join(root, "app");
    await writeFile(path, elfFrameAllowanceFixture());
    const reason = new Error("stop hardening frames");
    const controller = new AbortController();
    const yieldImpl = scheduler.yield.bind(scheduler);
    let yields = 0;
    const spy = vi.spyOn(scheduler, "yield").mockImplementation(async () => {
      yields += 1;
      await yieldImpl();
      if (yields === 1) controller.abort(reason);
    });
    const service = createBinaryHardeningService();
    try {
      const result = await service.inspect(
        { path },
        { signal: controller.signal },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        _tag: "AnalysisCancelledError",
        operation: "inspect_binary_hardening",
        cause: reason,
      });
    } finally {
      spy.mockRestore();
      await service.close();
    }
  });
});
