/** Compile multi-file C fixtures with GCC/Clang and cross-check `.debug_line` against readelf. */
import { mkdir, writeFile } from "node:fs/promises";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { VerifierFixture } from "./lib/verifier-fixture.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { importVerifierSource } from "./lib/verifier-source-loader.mjs";

const commandExists = (name) =>
  (name.includes("/")
    ? [name]
    : (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, name))
  ).some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

const readelfBin = commandExists("readelf") ? "readelf" : undefined;
const nmBin = commandExists("nm") ? "nm" : undefined;

const ELF_VARIANTS = [
  {
    id: "clang-dwarf2",
    cc: "clang",
    args: ["-gdwarf-2", "-O0"],
    expect: { version: 2, compression: "none", offsetSize: 4 },
  },
  {
    id: "clang-dwarf3",
    cc: "clang",
    args: ["-gdwarf-3", "-O0"],
    expect: { version: 3, compression: "none", offsetSize: 4 },
  },
  {
    id: "clang-dwarf4",
    cc: "clang",
    args: ["-gdwarf-4", "-O0"],
    expect: { version: 4, compression: "none", offsetSize: 4 },
  },
  {
    id: "clang-dwarf5",
    cc: "clang",
    args: ["-gdwarf-5", "-O0"],
    expect: { version: 5, compression: "none", offsetSize: 4 },
  },
  {
    id: "clang-dwarf5-O2",
    cc: "clang",
    args: ["-gdwarf-5", "-O2"],
    expect: { version: 5, compression: "none", offsetSize: 4 },
  },
  {
    id: "clang-dwarf64",
    cc: "clang",
    args: ["-gdwarf-5", "-gdwarf64", "-O0"],
    expect: { version: 5, compression: "none", offsetSize: 8 },
  },
  {
    id: "clang-zlib",
    cc: "clang",
    args: [
      "-gdwarf-5",
      "-O0",
      "-gz=zlib",
      "-Wl,--compress-debug-sections=zlib",
    ],
    expect: { version: 5, compression: "zlib", offsetSize: 4 },
  },
  {
    id: "clang-zstd",
    cc: "clang",
    args: [
      "-gdwarf-5",
      "-O0",
      "-gz=zstd",
      "-Wl,--compress-debug-sections=zstd",
    ],
    expect: { version: 5, compression: "zstd", offsetSize: 4 },
  },
  {
    id: "gcc-dwarf4",
    cc: "gcc",
    args: ["-gdwarf-4", "-O2"],
    expect: { version: 4, compression: "none", offsetSize: 4 },
  },
  {
    id: "gcc-dwarf5",
    cc: "gcc",
    args: ["-gdwarf-5", "-O2"],
    expect: { version: 5, compression: "none", offsetSize: 4 },
  },
  {
    id: "gcc-zstd",
    cc: "gcc",
    args: [
      "-gdwarf-5",
      "-O0",
      "-gz=zstd",
      "-Wl,--compress-debug-sections=zstd",
    ],
    expect: { version: 5, compression: "zstd", offsetSize: 4 },
  },
];

/** Parse `readelf --debug-dump=rawline` headers for offset, payload length, and DWARF version. */
export const parseReadelfRawLine = (text) => {
  const programs = [];
  let current = null;
  for (const line of text.split(/\r?\n/u)) {
    const offMatch = /^\s*Offset:\s*(0x[0-9a-f]+|\d+)\s*$/iu.exec(line);
    if (offMatch?.[1] !== undefined) {
      if (current !== null) programs.push(current);
      current = {
        offset:
          offMatch[1].startsWith("0x") || offMatch[1].startsWith("0X")
            ? Number.parseInt(offMatch[1], 16)
            : Number.parseInt(offMatch[1], 10),
        length: null,
        version: null,
      };
      continue;
    }
    if (current === null) continue;
    const lenMatch = /^\s*Length:\s*(0x[0-9a-f]+|\d+)\b/iu.exec(line);
    if (lenMatch?.[1] !== undefined) {
      current.length =
        lenMatch[1].startsWith("0x") || lenMatch[1].startsWith("0X")
          ? Number.parseInt(lenMatch[1], 16)
          : Number.parseInt(lenMatch[1], 10);
      continue;
    }
    const verMatch = /^\s*DWARF Version:\s*(\d+)\b/u.exec(line);
    if (verMatch?.[1] !== undefined) {
      current.version = Number.parseInt(verMatch[1], 10);
    }
  }
  if (current !== null) programs.push(current);
  return programs;
};

/** Parse `readelf --debug-dump=decodedline` rows into (basename, line, addressHex) tuples. */
export const parseReadelfDecodedLine = (text) => {
  const rows = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(\S+?)\s+(\d+|-)\s+(0x[0-9a-f]+)\b/iu.exec(line);
    if (match === null) continue;
    const file = match[1];
    const lineNum = match[2] === "-" ? null : Number.parseInt(match[2], 10);
    const addr = `0x${BigInt(match[3]).toString(16)}`;
    if (file === "File" || lineNum === null) continue;
    rows.push({ file, line: lineNum, address: addr });
  }
  return rows;
};

const runCmd = async (commands, cmd, args, cwd) => {
  const res = await commands.exec(cmd, args, {
    cwd,
    timeout: 120_000,
    stdin: "closed-pipe",
  });
  return res.stdout;
};

const writeFixtureSources = async (dir) => {
  await mkdir(join(dir, "include"), { recursive: true });
  await writeFile(
    join(dir, "include", "helper.h"),
    [
      "static inline int helper_add(int a, int b) {",
      "  int sum = a + b;",
      "  return sum * 2;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "alpha.c"),
    [
      '#include "include/helper.h"',
      "volatile int g_sink = 0;",
      "__attribute__((noinline)) int alpha(int x) {",
      "  int y = helper_add(x, 3);",
      "  g_sink = y;",
      "  return y + 1;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "beta.c"),
    [
      "int alpha(int x);",
      "int main(void) {",
      "  int v = alpha(7);",
      "  return v == 21 ? 0 : 1;",
      "}",
      "",
    ].join("\n"),
  );
};

const extractSymbolAddress = async (commands, binary, symbol) => {
  if (nmBin === undefined) return null;
  const out = await runCmd(commands, nmBin, ["-n", binary]);
  for (const line of out.split(/\r?\n/u)) {
    const match = new RegExp(`^([0-9a-f]+)\\s+\\w\\s+${symbol}$`, "u").exec(
      line.trim(),
    );
    if (match?.[1] !== undefined) {
      return `0x${BigInt(`0x${match[1]}`).toString(16)}`;
    }
  }
  return null;
};

const invokedDirectly = () => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
};

const main = async () => {
  if (readelfBin === undefined) {
    throw new Error("readelf is required for DWARF line verification");
  }
  const commands = await createVerifierCommands();
  let fixture;
  await withVerifierCleanup(async () => {
    fixture = await VerifierFixture.open({ prefix: "rea-dwarf-lines-" });
    const root = fixture.path;
    await writeFixtureSources(root);
    const { createDwarfLinesService } = await importVerifierSource(
      "../src/composition/binaryDiagnostics.ts",
      import.meta.url,
    );
    const service = createDwarfLinesService();
    const results = [];
    try {
      for (const variant of ELF_VARIANTS) {
        if (!commandExists(variant.cc)) {
          results.push({
            id: variant.id,
            status: "skipped",
            reason: `${variant.cc} missing`,
          });
          continue;
        }
        const outBin = join(root, `prog-${variant.id}`);
        try {
          await runCmd(
            commands,
            variant.cc,
            [...variant.args, "alpha.c", "beta.c", "-o", outBin],
            root,
          );
        } catch (cause) {
          results.push({
            id: variant.id,
            status: "skipped",
            reason: cause instanceof Error ? cause.message : String(cause),
          });
          continue;
        }

        const alphaAddr = await extractSymbolAddress(commands, outBin, "alpha");
        const interiorAddr =
          alphaAddr === null
            ? null
            : `0x${(BigInt(alphaAddr) + 4n).toString(16)}`;
        const queryAddrs =
          alphaAddr !== null && interiorAddr !== null
            ? [alphaAddr, interiorAddr]
            : undefined;

        const inspected = await service.inspect({
          path: outBin,
          max_programs: 1024,
          max_rows: 16384,
          ...(queryAddrs === undefined ? {} : { addresses: queryAddrs }),
        });
        if (!inspected.ok) throw inspected.error;
        const report = inspected.value.normalized_result;
        const rawText = await runCmd(commands, readelfBin, [
          "--debug-dump=rawline",
          outBin,
        ]);
        const decText = await runCmd(commands, readelfBin, [
          "--debug-dump=decodedline",
          outBin,
        ]);
        const rawProgs = parseReadelfRawLine(rawText);
        const decRows = parseReadelfDecodedLine(decText);

        if (report.programs.length !== rawProgs.length) {
          throw new Error(
            `${variant.id}: REA decoded ${report.programs.length} programs vs readelf ${rawProgs.length}`,
          );
        }
        for (let i = 0; i < rawProgs.length; i += 1) {
          const rp = report.programs[i];
          const dp = rawProgs[i];
          const payloadLen = rp.length - (rp.offset_size === 8 ? 12 : 4);
          if (
            rp.offset !== dp.offset ||
            rp.version !== dp.version ||
            payloadLen !== dp.length
          ) {
            throw new Error(
              `${variant.id} program ${i}: header mismatch (REA off=${rp.offset} v${rp.version} len=${payloadLen} vs readelf off=${dp.offset} v${dp.version} len=${dp.length})`,
            );
          }
        }
        const lineSec = report.sections.find((s) => s.role === ".debug_line");
        if (lineSec?.compression !== variant.expect.compression) {
          throw new Error(
            `${variant.id}: expected compression ${variant.expect.compression}, got ${lineSec?.compression}`,
          );
        }
        const userProgs = report.programs.filter((p) =>
          p.files.some(
            (f) => f.name.value === "alpha.c" || f.name.value === "beta.c",
          ),
        );
        if (userProgs.length < 2) {
          throw new Error(
            `${variant.id}: missing alpha.c or beta.c line program`,
          );
        }
        if (
          !userProgs.some(
            (p) =>
              p.version === variant.expect.version &&
              p.offset_size === variant.expect.offsetSize,
          )
        ) {
          throw new Error(
            `${variant.id}: user CU did not match expected DWARF v${variant.expect.version}/${variant.expect.offsetSize}`,
          );
        }
        const fileBasename = (filePath) => {
          const idx = Math.max(
            filePath.lastIndexOf("/"),
            filePath.lastIndexOf("\\"),
          );
          return idx >= 0 ? filePath.slice(idx + 1) : filePath;
        };
        const isUserFile = (filePath) => {
          const base = fileBasename(filePath);
          return base === "alpha.c" || base === "beta.c" || base === "helper.h";
        };
        const addTupleCount = (counts, file, line, address) => {
          const key = `${fileBasename(file)}|${line}|${address}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        };
        const decCounts = new Map();
        for (const dec of decRows) {
          if (!isUserFile(dec.file)) continue;
          addTupleCount(decCounts, dec.file, dec.line, dec.address);
        }
        const reaCounts = new Map();
        for (const r of report.rows) {
          if (r.end_sequence || r.file === null || !isUserFile(r.file)) {
            continue;
          }
          addTupleCount(reaCounts, r.file, r.line, r.address);
        }
        for (const [key, expectedCount] of decCounts) {
          const actualCount = reaCounts.get(key) ?? 0;
          if (actualCount !== expectedCount) {
            throw new Error(
              `${variant.id}: tuple ${key} count mismatch (readelf=${expectedCount}, rea=${actualCount})`,
            );
          }
        }
        if (reaCounts.size !== decCounts.size) {
          throw new Error(
            `${variant.id}: user row key set size mismatch (readelf=${decCounts.size}, rea=${reaCounts.size})`,
          );
        }
        if (queryAddrs !== undefined) {
          for (const entry of report.address_matches) {
            if (entry.status !== "resolved" || entry.matches.length === 0) {
              throw new Error(
                `${variant.id}: failed to resolve ${entry.query_address}`,
              );
            }
            const targetBig = BigInt(entry.query_address);
            let bestAddr = null;
            for (const dec of decRows) {
              const decAddr = BigInt(dec.address);
              if (
                decAddr <= targetBig &&
                (bestAddr === null || decAddr > bestAddr)
              ) {
                bestAddr = decAddr;
              }
            }
            if (bestAddr === null) {
              throw new Error(
                `${variant.id}: readelf has no row <= ${entry.query_address}`,
              );
            }
            const expectedRows = decRows.filter(
              (dec) => BigInt(dec.address) === bestAddr && isUserFile(dec.file),
            );
            for (const exp of expectedRows) {
              const found = entry.matches.some(
                (m) =>
                  m.file !== null &&
                  fileBasename(m.file) === fileBasename(exp.file) &&
                  m.line === exp.line,
              );
              if (!found) {
                throw new Error(
                  `${variant.id}: address ${entry.query_address} missing expected match ${fileBasename(exp.file)}:${exp.line}`,
                );
              }
            }
          }
        }
        results.push({
          id: variant.id,
          status: "passed",
          programs: report.programs.length,
          rows: report.total_rows,
          compression: lineSec?.compression,
          alpha_resolved:
            report.address_matches[0]?.matches.map(
              (m) => `${m.file}:${m.line}`,
            ) ?? [],
        });
      }

      const relObj = join(root, "alpha.o");
      const relCc = commandExists("clang") ? "clang" : "gcc";
      await runCmd(
        commands,
        relCc,
        ["-gdwarf-5", "-c", "alpha.c", "-o", relObj],
        root,
      );
      const relInspected = await service.inspect({
        path: relObj,
        addresses: ["0x0"],
      });
      if (!relInspected.ok) throw relInspected.error;
      const relReport = relInspected.value.normalized_result;
      if (!relReport.programs[0]?.addresses_unresolved) {
        throw new Error("ET_REL alpha.o must mark addresses_unresolved");
      }
      if (relReport.address_matches[0]?.status !== "unapplied_relocation") {
        throw new Error(
          `ET_REL address status expected unapplied_relocation, got ${relReport.address_matches[0]?.status}`,
        );
      }
      results.push({
        id: `${relCc}-et-rel`,
        status: "passed",
        programs: relReport.programs.length,
        rows: relReport.total_rows,
        addresses_unresolved: true,
      });
    } finally {
      await service.close();
    }
    console.log(JSON.stringify({ ok: true, results }, null, 2));
  }, [
    async () => {
      await commands.close();
      await fixture?.release();
    },
  ]);
};

if (invokedDirectly()) await main();
