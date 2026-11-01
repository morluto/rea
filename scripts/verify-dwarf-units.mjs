/** Compile a two-file C fixture and compare compile-unit facts with a DWARF dumper. */
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { importVerifierSource } from "./lib/verifier-source-loader.mjs";

const commandExists = (name) => {
  try {
    execFileSync("/usr/bin/which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const compiler = ["clang", "gcc"].find((name) => commandExists(name));
const dumper = [
  process.env.REA_DWARFDUMP,
  "llvm-dwarfdump",
  "/opt/homebrew/opt/llvm/bin/llvm-dwarfdump",
  "/usr/bin/llvm-dwarfdump",
  "/usr/bin/dwarfdump",
  "dwarfdump",
  "readelf",
].find(
  (name) =>
    name !== undefined &&
    (name.includes("/") ? existsSync(name) : commandExists(name)),
);

const ELF_TARGET = ["-target", "x86_64-unknown-linux-gnu"];
const PE_TARGET = ["-target", "x86_64-w64-mingw32"];

/**
 * `expect` fields make a variant fail when it did not exercise what it names.
 * Apple clang accepts `-gz` and `-gsplit-dwarf` on Mach-O and ignores them, so
 * those rows carry no expectation.
 */
const variants = [
  { id: "dwarf4", args: ["-gdwarf-4", "-g"], expect: { version: 4 } },
  { id: "dwarf5", args: ["-gdwarf-5", "-g"], expect: { version: 5 } },
  { id: "zlib", args: ["-gdwarf-5", "-g", "-gz=zlib"] },
  { id: "zstd", args: ["-gdwarf-5", "-g", "-gz=zstd"] },
  { id: "split", args: ["-gdwarf-5", "-g", "-gsplit-dwarf"] },
  {
    id: "elf-dwarf2",
    args: [...ELF_TARGET, "-gdwarf-2", "-g"],
    expect: { version: 2 },
  },
  {
    id: "elf-dwarf3",
    args: [...ELF_TARGET, "-gdwarf-3", "-g"],
    expect: { version: 3 },
  },
  {
    id: "elf-dwarf4",
    args: [...ELF_TARGET, "-gdwarf-4", "-g"],
    expect: { version: 4 },
  },
  {
    id: "elf-dwarf5",
    args: [...ELF_TARGET, "-gdwarf-5", "-g"],
    expect: { version: 5 },
  },
  {
    id: "elf-dwarf64",
    args: [...ELF_TARGET, "-gdwarf-5", "-gdwarf64", "-g"],
    expect: { version: 5, offsetSize: 8 },
  },
  {
    id: "elf-zlib",
    args: [...ELF_TARGET, "-gdwarf-5", "-g", "-gz=zlib"],
    expect: { version: 5, compression: "zlib" },
  },
  {
    id: "elf-zstd",
    args: [...ELF_TARGET, "-gdwarf-5", "-g", "-gz=zstd"],
    expect: { version: 5, compression: "zstd" },
  },
  {
    id: "elf-split",
    args: [...ELF_TARGET, "-gdwarf-5", "-g", "-gsplit-dwarf"],
    expect: { version: 5, dwoNames: true },
  },
  {
    id: "elf-dwarf4-split",
    args: [...ELF_TARGET, "-gdwarf-4", "-g", "-gsplit-dwarf"],
    expect: { version: 4, dwoNames: true },
  },
  {
    id: "elf-big-endian",
    args: ["-target", "powerpc-unknown-linux-gnu", "-gdwarf-4", "-g"],
    expect: { version: 4 },
  },
  {
    id: "elf-big-endian-aarch64",
    args: ["-target", "aarch64_be-unknown-linux-gnu", "-gdwarf-4", "-g"],
    expect: { version: 4 },
  },
  {
    id: "pe-dwarf4",
    args: [...PE_TARGET, "-gdwarf-4", "-g"],
    expect: { version: 4 },
  },
  {
    id: "pe-dwarf5",
    args: [...PE_TARGET, "-gdwarf-5", "-g"],
    expect: { version: 5 },
  },
];

const quoted = (line) => {
  const match = /"((?:\\.|[^"\\])*)"/u.exec(line);
  if (match?.[1] !== undefined) return match[1].replace(/\\"/gu, '"');
  const colon = line.lastIndexOf(":");
  if (colon < 0) return null;
  const tail = line.slice(colon + 1).trim();
  return tail === "" ? null : tail;
};

const attribute = (line) => {
  const match = /(?:DW_)?AT_(?:GNU_)?(dwo_name|comp_dir|producer|name)\b/u.exec(
    line,
  );
  if (match?.[1] === undefined) return null;
  const value = quoted(line);
  return value === null ? null : { key: match[1], value };
};

const versionOf = (line) => {
  const match =
    /version\s*=\s*0x([0-9a-f]+)/iu.exec(line) ??
    /\bVersion:\s+([0-9]+)/u.exec(line);
  if (match?.[1] === undefined) return null;
  return Number.parseInt(match[1], match[1].length > 2 ? 16 : 10);
};

/**
 * Pull unit version, name, comp_dir, and producer in file order.
 * `readelf --debug-dump=info` prints the compilation-unit marker and
 * `Version:` on separate lines. llvm-dwarfdump keeps both on one line.
 */
export const parseDumperUnits = (text) => {
  const units = [];
  let current = null;
  const push = () => {
    if (current !== null) units.push(current);
  };
  for (const line of text.split(/\r?\n/u)) {
    const version = versionOf(line);
    const header = /Compilation Unit|Compile Unit/u.test(line);
    const tagged =
      /TAG_compile_unit|DW_TAG_compile_unit|DW_TAG_skeleton_unit/u.test(line);
    if (header || (tagged && version !== null)) {
      push();
      current = {
        version,
        name: null,
        comp_dir: null,
        producer: null,
        dwo_name: null,
      };
      continue;
    }
    if (current === null) continue;
    if (current.version === null && version !== null) {
      current.version = version;
      continue;
    }
    const fact = attribute(line);
    if (fact !== null && current[fact.key] === null)
      current[fact.key] = fact.value;
  }
  push();
  return units;
};

const run = (command, args, cwd) => {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    const stderr =
      cause instanceof Error && "stderr" in cause
        ? String(cause.stderr).trim()
        : "";
    const stdout =
      cause instanceof Error && "stdout" in cause
        ? String(cause.stdout).trim()
        : "";
    const detail = [stderr, stdout].filter((part) => part !== "").join("\n");
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(detail === "" ? message : detail);
  }
};

const dumpUnits = (binary) => {
  if (dumper === undefined) throw new Error("No DWARF dumper is installed");
  const base = dumper.split("/").at(-1);
  const args =
    base === "readelf"
      ? ["--debug-dump=info", binary]
      : ["--debug-info", binary];
  return parseDumperUnits(run(dumper, args, undefined));
};

const inspectUnits = async (binary) => {
  const { createDwarfUnitsService } = await importVerifierSource(
    "../src/composition/binaryDiagnostics.ts",
    import.meta.url,
  );
  const service = createDwarfUnitsService();
  try {
    const result = await service.inspect({ path: binary, limit: 256 });
    if (!result.ok) throw result.error;
    const report = result.value.normalized_result;
    if (report.total_units > report.units.length)
      throw new Error(
        `${binary} has ${String(report.total_units)} units and the page returned ${String(report.units.length)}`,
      );
    return {
      report,
      units: report.units.map((unit) => ({
        version: unit.version,
        name: unit.name.value,
        comp_dir: unit.comp_dir.value,
        producer: unit.producer.value,
        dwo_name: unit.dwo_name.value,
      })),
      offsetSizes: report.units.map((unit) => unit.offset_size),
      infoCompression: report.sections
        .filter((section) => section.role === ".debug_info")
        .map((section) => section.compression),
    };
  } finally {
    await service.close();
  }
};

const isElf = async (path) =>
  (await readFile(path)).subarray(0, 4).toString("binary") === "\u007fELF";

const linkPe = (directory, objects) => {
  if (!commandExists("ld.lld"))
    throw new Error("ld.lld is absent, so no PE image was linked");
  const output = join(directory, "program.exe");
  run(
    "ld.lld",
    [
      "-m",
      "i386pep",
      "--entry",
      "alpha",
      "--subsystem",
      "console",
      ...objects,
      "-o",
      output,
    ],
    directory,
  );
  return [output];
};

const linkArgs = (variant) => {
  if (variant.args.includes("-gz=zstd"))
    return ["--compress-debug-sections=zstd"];
  if (variant.args.includes("-gz=zlib"))
    return ["--compress-debug-sections=zlib"];
  return [];
};

const compileVariant = async (directory, variant) => {
  if (compiler === undefined) throw new Error("clang or gcc is not installed");
  await writeFixture(directory);
  const objects = [join(directory, "alpha.o"), join(directory, "beta.o")];
  run(compiler, [...variant.args, "-c", "alpha.c", "-o", "alpha.o"], directory);
  run(compiler, [...variant.args, "-c", "beta.c", "-o", "beta.o"], directory);
  let binaries = objects;
  if (variant.args.includes(PE_TARGET[1])) {
    binaries = linkPe(directory, objects);
  } else if (await isElf(objects[0])) {
    if (!commandExists("ld.lld"))
      throw new Error("ld.lld is absent, so ELF relocations were not applied");
    const output = join(directory, "program");
    run(
      "ld.lld",
      ["-e", "alpha", ...linkArgs(variant), ...objects, "-o", output],
      directory,
    );
    binaries = [output];
  }
  const aside = join(directory, "dwo");
  await mkdir(aside);
  for (const name of await readdir(directory)) {
    if (name.endsWith(".dwo"))
      await rename(join(directory, name), join(aside, name));
  }
  return binaries;
};

const writeFixture = async (directory) => {
  await writeFile(
    join(directory, "alpha.c"),
    "int alpha(void) { return 1; }\n",
  );
  await writeFile(join(directory, "beta.c"), "int beta(void) { return 2; }\n");
};

const issueCodes = (unit) => unit.issues.map(({ code }) => code);

/** Files the dumper reads and `inspect_dwarf_units` must not claim to resolve. */
const checkBoundaries = async (root) => {
  const directory = join(root, "boundaries");
  await mkdir(directory);
  await writeFixture(directory);
  const elf = [
    ...(compiler === "clang" ? ELF_TARGET : []),
    "-gdwarf-5",
    "-g",
    "-c",
  ];
  run(compiler, [...elf, "alpha.c", "-o", "alpha.o"], directory);
  run(compiler, [...elf, "beta.c", "-o", "beta.o"], directory);
  run(
    compiler,
    [...elf, "-gsplit-dwarf", "alpha.c", "-o", "split.o"],
    directory,
  );
  run("ld.lld", ["-r", "alpha.o", "beta.o", "-o", "merged.o"], directory);
  const rows = [];

  const single = (await inspectUnits(join(directory, "alpha.o"))).report;
  const [object] = single.units;
  if (
    single.total_units !== 1 ||
    object?.abbrev_offset !== 0 ||
    object.language.state !== "present" ||
    object.name.state !== "unresolved" ||
    object.stmt_list.state !== "unresolved"
  )
    throw new Error(`ET_REL object: ${JSON.stringify(single)}`);
  rows.push({ id: "elf-relocatable-object", units: 1, coverage: "complete" });

  const merged = (await inspectUnits(join(directory, "merged.o"))).report;
  if (
    merged.total_units !== dumpUnits(join(directory, "merged.o")).length ||
    merged.units.some(
      (unit) =>
        unit.abbrev_offset !== null ||
        unit.name.state !== "unknown" ||
        !issueCodes(unit).includes("unapplied_relocation"),
    )
  )
    throw new Error(`ld -r object: ${JSON.stringify(merged)}`);
  rows.push({
    id: "elf-relocatable-merged",
    units: merged.total_units,
    coverage: merged.coverage.status,
  });

  const dwo = (await inspectUnits(join(directory, "split.dwo"))).report;
  if (
    dwo.coverage.status !== "partial" ||
    dwo.coverage.reason !== "Split DWARF section .debug_info.dwo is not read"
  )
    throw new Error(`Split DWARF object: ${JSON.stringify(dwo)}`);
  rows.push({ id: "elf-dwo-object", units: 0, coverage: dwo.coverage.status });
  return rows;
};

const expectationFailure = (expected, row) => {
  if (expected === undefined) return null;
  if (expected.version !== undefined && row.version !== expected.version)
    return `version ${String(row.version)}`;
  if (
    expected.compression !== undefined &&
    !row.info_compression.includes(expected.compression)
  )
    return `.debug_info compression ${row.info_compression.join(",")}`;
  if (expected.dwoNames === true && row.dwo_names !== row.units)
    return `${String(row.dwo_names)} dwo_name of ${String(row.units)} units`;
  if (
    expected.offsetSize !== undefined &&
    !row.offset_sizes.includes(expected.offsetSize)
  )
    return `offset sizes ${row.offset_sizes.join(",")}`;
  return null;
};

const sameUnit = (left, right) =>
  left.version === right.version &&
  left.name === right.name &&
  left.comp_dir === right.comp_dir &&
  left.producer === right.producer &&
  left.dwo_name === right.dwo_name;

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
  const root = await mkdtemp(join(tmpdir(), "rea-dwarf-units-"));
  const checked = [];
  const skipped = [];
  const boundaries = [];
  try {
    if (compiler === undefined || dumper === undefined) {
      skipped.push({
        id: "all",
        reason:
          compiler === undefined
            ? "clang and gcc are absent"
            : "llvm-dwarfdump, dwarfdump, and readelf are absent",
      });
    } else {
      for (const variant of variants) {
        const directory = join(root, variant.id);
        await mkdir(directory);
        let binaries;
        try {
          binaries = await compileVariant(directory, variant);
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          skipped.push({
            id: variant.id,
            reason:
              reason.split("\n").find((line) => line.trim() !== "") ?? reason,
          });
          continue;
        }
        let units = 0;
        let dwoNames = 0;
        let version = null;
        const infoCompression = new Set();
        const offsetSizes = new Set();
        for (const binary of binaries) {
          const dumped = dumpUnits(binary);
          const inspected = await inspectUnits(binary);
          if (
            dumped.length === 0 ||
            dumped.length !== inspected.units.length ||
            dumped.some(
              (unit, index) => !sameUnit(unit, inspected.units[index]),
            )
          ) {
            console.error(
              JSON.stringify(
                { id: variant.id, binary, dumped, inspected },
                null,
                2,
              ),
            );
            throw new Error(`${variant.id} disagreed with ${dumper}`);
          }
          units += inspected.units.length;
          dwoNames += inspected.units.filter(
            (unit) => unit.dwo_name !== null,
          ).length;
          for (const size of inspected.offsetSizes) offsetSizes.add(size);
          version ??= inspected.units[0]?.version ?? null;
          for (const compression of inspected.infoCompression)
            infoCompression.add(compression);
        }
        const row = {
          id: variant.id,
          binaries: binaries.length,
          units,
          dwo_names: dwoNames,
          version,
          offset_sizes: [...offsetSizes],
          info_compression: [...infoCompression],
          dumper,
        };
        const failure = expectationFailure(variant.expect, row);
        if (failure !== null)
          throw new Error(`${variant.id} did not exercise it: ${failure}`);
        checked.push(row);
      }
      boundaries.push(...(await checkBoundaries(root)));
    }
    if (checked.length === 0)
      throw new Error(
        `No DWARF variant was compared. Skipped: ${JSON.stringify(skipped)}`,
      );
    console.log(
      JSON.stringify(
        { compiler, dumper, checked, boundaries, skipped },
        null,
        2,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

if (invokedDirectly()) await main();
