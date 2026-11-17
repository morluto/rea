import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import {
  dwarfLinesSchema,
  inspectDwarfLinesInputSchema,
} from "../../domain/native/dwarfLines.js";
import { DwarfLinesProvider } from "./DwarfLinesProvider.js";
import {
  buildStringTable,
  decompressionBombBody,
  elfCompressedBody,
  elfDebugLineImage,
  elfImage,
  gnuZdebugBody,
  lineProgram,
  lneEndSequence,
  lneSetAddress,
  lnsAdvancePc,
  lnsCopy,
  lnsSetFile,
  macho64,
  peImage,
} from "./DwarfLines.fixture.js";

const SHF_COMPRESSED = 0x800n;
const SHT_NOBITS = 8;

const fatMacho = (
  slices: readonly {
    readonly cpuType: number;
    readonly cpuSubtype?: number;
    readonly bytes: Buffer;
  }[],
): Buffer => {
  const headerBytes = 8 + slices.length * 20;
  let offset = Math.ceil(headerBytes / 4096) * 4096;
  const alignedOffsets = slices.map((slice) => {
    const start = offset;
    offset += Math.ceil(slice.bytes.length / 4096) * 4096;
    return start;
  });
  const out = Buffer.alloc(offset);
  out.writeUInt32BE(0xcafebabe, 0);
  out.writeUInt32BE(slices.length, 4);
  slices.forEach((slice, i) => {
    const rec = 8 + i * 20;
    const start = alignedOffsets[i]!;
    out.writeUInt32BE(slice.cpuType >>> 0, rec);
    out.writeUInt32BE((slice.cpuSubtype ?? 0) >>> 0, rec + 4);
    out.writeUInt32BE(start, rec + 8);
    out.writeUInt32BE(slice.bytes.length, rec + 12);
    out.writeUInt32BE(12, rec + 16);
    slice.bytes.copy(out, start);
  });
  return out;
};

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

const makeTempFile = async (name: string, bytes: Buffer): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "rea-dwarf-lines-"));
  tempDirs.push(dir);
  const filePath = join(dir, name);
  await writeFile(filePath, bytes);
  return filePath;
};

it("reads ELF compressed, PE32+, and universal Mach-O slices accurately", async () => {
  const strings = buildStringTable(["/src", "hello.c"]);
  const prog = lineProgram({
    version: 5,
    addressSize: 8,
    v5Directories: [{ form: 0x1f, lineStrp: strings.offsets[0]! }],
    v5Files: [
      { path: { form: 0x1f, lineStrp: strings.offsets[1]! }, dirIndex: 0 },
    ],
    opcodes: Buffer.concat([
      lneSetAddress(0x1000n, 8, true),
      lnsSetFile(0),
      lnsCopy(),
      Buffer.concat([lneSetAddress(0x1010n, 8, true), lneEndSequence()]),
    ]),
  });

  const provider = new DwarfLinesProvider();
  try {
    const compressedElfPath = await makeTempFile(
      "compressed.elf",
      elfImage({
        type: 2,
        sections: [
          {
            name: ".debug_line",
            body: elfCompressedBody(prog, "zstd"),
            flags: SHF_COMPRESSED,
          },
          {
            name: ".zdebug_line_str",
            body: gnuZdebugBody(strings.table),
          },
        ],
      }),
    );
    const elfRes = await provider.inspect(
      inspectDwarfLinesInputSchema.parse({
        path: compressedElfPath,
        addresses: ["0x1004"],
      }),
    );
    if (!elfRes.ok) throw elfRes.error;
    const elfParsed = dwarfLinesSchema.parse(elfRes.value);
    expect(elfParsed.debug_line).toBe("present");
    expect(elfParsed.programs[0]?.file_offset).toBeNull();
    expect(elfParsed.address_matches[0]?.status).toBe("resolved");
    expect(elfParsed.address_matches[0]?.matches[0]?.path).toBe("/src/hello.c");

    const pePath = await makeTempFile(
      "sample.exe",
      peImage([{ name: ".debug_line", body: lineProgram({ version: 4 }) }]),
    );
    const peRes = await provider.inspect(
      inspectDwarfLinesInputSchema.parse({ path: pePath }),
    );
    if (!peRes.ok) throw peRes.error;
    expect(dwarfLinesSchema.parse(peRes.value)).toMatchObject({
      format: "pe",
      debug_line: "present",
    });

    const fat = fatMacho([
      {
        cpuType: 0x01000007,
        bytes: macho64({
          cpuType: 0x01000007,
          sections: [
            { name: "__debug_line", body: lineProgram({ version: 4 }) },
          ],
        }),
      },
      {
        cpuType: 0x0100000c,
        bytes: macho64({
          cpuType: 0x0100000c,
          sections: [
            { name: "__debug_line", body: prog },
            { name: "__debug_line_str", body: strings.table },
          ],
        }),
      },
    ]);
    const fatPath = await makeTempFile("fat.macho", fat);
    const missingArch = await provider.inspect(
      inspectDwarfLinesInputSchema.parse({ path: fatPath }),
    );
    expect(missingArch.ok).toBe(false);
    if (!missingArch.ok) {
      expect(missingArch.error).toBeInstanceOf(AnalysisInputError);
    }

    const arm64Res = await provider.inspect(
      inspectDwarfLinesInputSchema.parse({
        path: fatPath,
        architecture: "arm64",
      }),
    );
    if (!arm64Res.ok) throw arm64Res.error;
    const armReport = dwarfLinesSchema.parse(arm64Res.value);
    expect(armReport.selected_slice?.container).toBe("fat");
    expect(armReport.programs[0]?.file_offset).toBeGreaterThanOrEqual(4096);
  } finally {
    await provider.close();
  }
});

it("handles absent/SHT_NOBITS sections, decompression bombs, file budgets, symlinks, and cancellation", async () => {
  const provider = new DwarfLinesProvider();
  try {
    const noDebugPath = await makeTempFile(
      "stripped.elf",
      elfImage({
        type: 2,
        sections: [
          { name: ".debug_line", body: Buffer.alloc(0), type: SHT_NOBITS },
        ],
      }),
    );
    const absentRes = await provider.inspect(
      inspectDwarfLinesInputSchema.parse({
        path: noDebugPath,
        addresses: ["0x1000"],
      }),
    );
    if (!absentRes.ok) throw absentRes.error;
    expect(absentRes.value).toMatchObject({
      debug_line: "absent",
      coverage: { status: "complete", reason: null },
      address_matches: [
        { query_address: "0x1000", status: "not_found", matches: [] },
      ],
    });

    const offsetOnAbsent = await provider.inspect(
      inspectDwarfLinesInputSchema.parse({
        path: noDebugPath,
        program_offset: 0,
      }),
    );
    expect(offsetOnAbsent.ok).toBe(false);
    if (!offsetOnAbsent.ok) {
      expect(offsetOnAbsent.error).toBeInstanceOf(AnalysisInputError);
      if (offsetOnAbsent.error instanceof AnalysisInputError) {
        expect(offsetOnAbsent.error.issues).toMatchObject([
          { path: ["program_offset"] },
        ]);
      }
    }

    const bombPath = await makeTempFile(
      "bomb.elf",
      elfDebugLineImage(
        { line: decompressionBombBody() },
        { lineFlags: SHF_COMPRESSED },
      ),
    );
    const bombRes = await provider.inspect(
      inspectDwarfLinesInputSchema.parse({ path: bombPath }),
    );
    expect(bombRes.ok).toBe(false);
    if (!bombRes.ok) {
      expect(bombRes.error).toBeInstanceOf(AnalysisResourceConstraintError);
      if (bombRes.error instanceof AnalysisResourceConstraintError) {
        expect(bombRes.error.resource).toBe("capacity");
      }
    }

    const tooBigRes = await provider.inspect(
      inspectDwarfLinesInputSchema.parse({
        path: noDebugPath,
        max_file_bytes: 64,
      }),
    );
    expect(tooBigRes.ok).toBe(false);
    if (!tooBigRes.ok) {
      expect(tooBigRes.error).toBeInstanceOf(AnalysisResourceConstraintError);
      if (tooBigRes.error instanceof AnalysisResourceConstraintError) {
        expect(tooBigRes.error.resource).toBe("file-size");
      }
    }

    const linkPath = `${noDebugPath}.link`;
    await symlink(noDebugPath, linkPath);
    const symRes = await provider.inspect(
      inspectDwarfLinesInputSchema.parse({ path: linkPath }),
    );
    expect(symRes.ok).toBe(false);
    if (!symRes.ok) {
      expect(symRes.error).toBeInstanceOf(AnalysisInputError);
    }

    const abortedRes = await provider.inspect(
      inspectDwarfLinesInputSchema.parse({ path: noDebugPath }),
      { signal: AbortSignal.abort("cancelled-test") },
    );
    expect(abortedRes.ok).toBe(false);
    if (!abortedRes.ok) {
      expect(abortedRes.error).toBeInstanceOf(AnalysisCancelledError);
    }

    const badOffsetElfBytes = elfDebugLineImage({
      line: lineProgram({ version: 5 }),
    });
    const badOffsetPath = await makeTempFile(
      "bad-offset.elf",
      badOffsetElfBytes,
    );
    const expectedSha = createHash("sha256")
      .update(badOffsetElfBytes)
      .digest("hex");
    const badOffsetRes = await provider.inspect(
      inspectDwarfLinesInputSchema.parse({
        path: badOffsetPath,
        program_offset: 999999,
      }),
    );
    expect(badOffsetRes.ok).toBe(false);
    if (!badOffsetRes.ok) {
      expect(badOffsetRes.error).toBeInstanceOf(AnalysisInputError);
      expect(badOffsetRes.error.partialObservation).toEqual({
        kind: "file-snapshot-hash",
        path: badOffsetPath,
        sha256: expectedSha,
        bytes: badOffsetElfBytes.length,
      });
    }
  } finally {
    await provider.close();
  }
});

it("marks MH_OBJECT Mach-O __DWARF,__debug_line relocations unresolved without false address matches", async () => {
  const provider = new DwarfLinesProvider();
  try {
    const strTable = buildStringTable(["/reloc_dir", "reloc.c"]);
    const relocProg = lineProgram({
      version: 5,
      v5Directories: [{ form: 0x0e, strp: strTable.offsets[0] ?? 0 }],
      v5Files: [
        {
          path: { form: 0x0e, strp: strTable.offsets[1] ?? 0 },
          dirIndex: 0,
        },
      ],
      opcodes: Buffer.concat([
        lneSetAddress(0x0n, 8, true),
        lnsSetFile(0),
        lnsCopy(),
        lnsAdvancePc(4),
        lneEndSequence(),
      ]),
    });

    const mhObjectPath = await makeTempFile(
      "reloc.o.macho",
      macho64({
        cpuType: 0x0100000c,
        fileType: 1,
        sections: [
          { name: "__debug_line", body: relocProg, relocationCount: 1 },
          { name: "__debug_str", body: strTable.table },
        ],
      }),
    );
    const relocRes = await provider.inspect(
      inspectDwarfLinesInputSchema.parse({
        path: mhObjectPath,
        addresses: ["0x0", "0x2", "0x2000"],
      }),
    );
    if (!relocRes.ok) throw relocRes.error;
    const relocReport = dwarfLinesSchema.parse(relocRes.value);
    expect(relocReport.programs[0]?.addresses_unresolved).toBe(true);
    expect(relocReport.programs[0]?.issues.map((i) => i.code)).toContain(
      "unapplied_relocation",
    );
    expect(relocReport.programs[0]?.files[0]?.name).toEqual({
      state: "unresolved",
      value: null,
    });
    expect(relocReport.address_matches.map((m) => m.status)).toEqual([
      "unapplied_relocation",
      "unapplied_relocation",
      "unapplied_relocation",
    ]);

    const strOnlyRelocPath = await makeTempFile(
      "str-reloc.o.macho",
      macho64({
        cpuType: 0x0100000c,
        fileType: 1,
        sections: [
          { name: "__debug_line", body: relocProg, relocationCount: 0 },
          { name: "__debug_str", body: strTable.table, relocationCount: 1 },
        ],
      }),
    );
    const strOnlyRes = await provider.inspect(
      inspectDwarfLinesInputSchema.parse({
        path: strOnlyRelocPath,
        addresses: ["0x2"],
      }),
    );
    if (!strOnlyRes.ok) throw strOnlyRes.error;
    expect(strOnlyRes.value.programs[0]?.files[0]?.name).toEqual({
      state: "unresolved",
      value: null,
    });
    expect(strOnlyRes.value.address_matches[0]?.status).toBe(
      "unapplied_relocation",
    );

    const linkedPath = await makeTempFile(
      "linked.macho",
      macho64({
        cpuType: 0x0100000c,
        fileType: 2,
        sections: [
          { name: "__debug_line", body: relocProg, relocationCount: 1 },
          { name: "__debug_str", body: strTable.table },
        ],
      }),
    );
    const linkedRes = await provider.inspect(
      inspectDwarfLinesInputSchema.parse({
        path: linkedPath,
        addresses: ["0x2"],
      }),
    );
    if (!linkedRes.ok) throw linkedRes.error;
    expect(linkedRes.value.programs[0]?.addresses_unresolved).toBe(false);
    expect(linkedRes.value.address_matches[0]?.status).toBe("resolved");
  } finally {
    await provider.close();
  }
});
