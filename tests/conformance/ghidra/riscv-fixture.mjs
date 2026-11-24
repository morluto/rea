import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FIXTURE_TOOLS, fixtureCommand } from "./fixture-toolchain.mjs";

const execute = promisify(execFile);

/** One build per float ABI the lane verifies, plus ESP-IDF's flash layout. */
const BUILDS = {
  double: {
    sources: ["../c/riscv.c", "./riscv-probe.S"],
    march: (bits) => `rv${bits}imafdc`,
    mabi: (bits) => (bits === 32 ? "ilp32d" : "lp64d"),
    flags: 5,
  },
  // ESP-IDF's ESP32-C2 and C3 base string, built ilp32 as ESP-IDF does.
  soft: {
    sources: [
      "../c/riscv-float-abi.c",
      "./riscv-probe.S",
      "./riscv-isa-probe.S",
    ],
    march: () => "rv32imc_zicsr_zifencei",
    mabi: () => "ilp32",
    flags: 1,
  },
  // ESP-IDF's ESP32-C6 base string and flash layout: the NOBITS
  // .flash_rodata_dummy reserves .flash.text's addresses.
  esp: {
    sources: ["../c/riscv-esp-layout.c"],
    march: () => "rv32imac_zicsr_zifencei",
    mabi: () => "ilp32",
    flags: 1,
    entry: "rea_riscv_esp_entry",
    linkerScript: "../esp/esp32c6-shared-window.ld",
  },
  // The same image with the reservation first in the section table.
  "esp-reservation-first": {
    sources: ["../c/riscv-esp-layout.c"],
    march: () => "rv32imac_zicsr_zifencei",
    mabi: () => "ilp32",
    flags: 1,
    entry: "rea_riscv_esp_entry",
    linkerScript: "../esp/esp32c6-reservation-first.ld",
  },
  // The same image with the reservation named like the default address space.
  "esp-reservation-named-ram": {
    sources: ["../c/riscv-esp-layout.c"],
    march: () => "rv32imac_zicsr_zifencei",
    mabi: () => "ilp32",
    flags: 1,
    entry: "rea_riscv_esp_entry",
    linkerScript: "../esp/esp32c6-reservation-named-ram.ld",
  },
  // The same image with the reservation and a disjoint section named like the
  // preparation's temporary blocks.
  "esp-edge-names": {
    sources: ["../c/riscv-esp-layout.c"],
    march: () => "rv32imac_zicsr_zifencei",
    mabi: () => "ilp32",
    flags: 1,
    entry: "rea_riscv_esp_entry",
    linkerScript: "../esp/esp32c6-edge-names.ld",
  },
};

const readerOptions = {
  env: { ...process.env, LC_ALL: "C" },
  timeout: 10000,
  maxBuffer: 1024 * 1024,
};

/** Independent reading of LLVM readelf's `-h -l -S -s -A` report. */
const readRiscvElf = async (reader, path, floatAbi, run = execute) => {
  const { stdout, stderr } = await run(
    reader,
    ["-h", "-l", "-S", "-s", "-A", "-W", path],
    readerOptions,
  );
  assert.equal(stderr.trim(), "", "Unexpected ELF reader diagnostics");
  const field = (expression, label) => {
    const matches = [...stdout.matchAll(expression)];
    assert.equal(matches.length, 1, `Missing or ambiguous readelf ${label}`);
    return matches[0][1].trim();
  };
  const sections = [
    ...stdout.matchAll(
      /^\s*\[\s*(\d+)\]\s+(\S+)\s+(\S+)\s+([\da-f]+)\s+([\da-f]+)\s+([\da-f]+)\s+[\da-f]+\s+(\S*)\s+\d+\s+\d+\s+\d+\s*$/gmu,
    ),
  ].map(([, index, name, type, address, offset, size, flags]) => ({
    index: Number(index),
    name,
    type,
    address: Number.parseInt(address, 16),
    offset: Number.parseInt(offset, 16),
    size: Number.parseInt(size, 16),
    allocated: flags.includes("A"),
    executable: flags.includes("X"),
  }));
  assert.ok(sections.length > 0, "Missing readelf section table");
  // LLVM readelf prints each attribute as Tag, TagName and Value lines.
  const arch = field(/TagName: arch\s*\n\s*Value: (\S+)\s*$/gmu, "arch");
  const [base, ...tokens] = arch.split("_");
  const declared = /^rv(32|64)([ie])/u.exec(base);
  assert.ok(declared !== null, `Unexpected Tag_RISCV_arch ${arch}`);
  return {
    stdout,
    sections,
    class: field(/^\s*Class:\s*(.+)$/gmu, "class"),
    data: field(/^\s*Data:\s*(.+)$/gmu, "byte order"),
    type: field(/^\s*Type:\s*(.+)$/gmu, "type"),
    machine: field(/^\s*Machine:\s*(.+)$/gmu, "machine"),
    flags: Number(field(/^\s*Flags:\s*(0x[\da-f]+).*$/gmu, "flags")),
    isa: {
      status: "declared",
      arch,
      xlen: Number(declared[1]),
      base: declared[2],
      extensions: tokens.map((token) => /^(.*?)(?:\d+p\d+)?$/u.exec(token)[1]),
    },
    floatAbi,
  };
};

/** REA's section-overlap fact, recomputed from LLVM readelf's section table. */
const sectionOverlapOf = (sections) => {
  const hex = (value) => `0x${value.toString(16)}`;
  const allocated = sections.filter(
    (section) => section.allocated && section.size > 0,
  );
  const pairs = allocated
    .filter((code) => code.executable && code.type === "PROGBITS")
    .flatMap((code) =>
      allocated
        .filter(
          (other) =>
            other !== code &&
            code.address < other.address + other.size &&
            other.address < code.address + code.size,
        )
        .map((other) => [code, other]),
    );
  if (pairs.length === 0) return { status: "none" };
  assert.equal(pairs.length, 1, "A fixture declares more than one overlap");
  const [[code, reservation]] = pairs;
  assert.equal(reservation.type, "NOBITS");
  assert.equal(reservation.executable, false);
  assert.equal(reservation.address, code.address);
  assert.ok(reservation.size >= code.size);
  return {
    status: "code-reservation",
    code: {
      index: code.index,
      name: code.name,
      address: hex(code.address),
      size: hex(code.size),
      offset: hex(code.offset),
    },
    reservation: {
      index: reservation.index,
      name: reservation.name,
      address: hex(reservation.address),
      size: hex(reservation.size),
    },
  };
};

const sha256 = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/** Build and independently inspect a source-owned ELF; never execute it. */
export async function buildRiscvFixture(directory, bits, buildOptions = {}) {
  const {
    variant = "double",
    pie = false,
    execute: run = execute,
  } = typeof buildOptions === "string"
    ? { variant: buildOptions }
    : buildOptions;
  assert.ok(bits === 32 || bits === 64);
  const build = BUILDS[variant];
  assert.ok(build !== undefined, `No ${variant} RISC-V fixture`);
  assert.ok(variant === "double" || bits === 32);
  const floatAbi = variant === "double" ? "double" : "soft";
  const compiler = fixtureCommand(FIXTURE_TOOLS.riscvClang);
  const linker = fixtureCommand(FIXTURE_TOOLS.riscvLinker);
  const reader = fixtureCommand(FIXTURE_TOOLS.riscvReadelf);
  const sources = build.sources.map((path) =>
    fileURLToPath(new URL(path, import.meta.url)),
  );
  const path = join(
    directory,
    `rv${bits}${variant === "double" ? "" : `-${variant}`}${pie ? "-pie" : ""}.elf`,
  );
  const interpreter =
    bits === 32
      ? "/lib/ld-linux-riscv32-ilp32d.so.1"
      : "/lib/ld-linux-riscv64-lp64d.so.1";
  const args = [
    `--target=riscv${bits}-unknown-elf`,
    `-march=${build.march(bits)}`,
    `-mabi=${build.mabi(bits)}`,
    `--ld-path=${linker}`,
    "-nostdlib",
    ...(pie
      ? ["-fPIE", "-Wl,-pie", `-Wl,--dynamic-linker=${interpreter}`]
      : ["-static", "-fno-pic"]),
    "-O0",
    "-g",
    `-Wl,-e,${build.entry ?? "rea_riscv_entry"}`,
    "-Wl,--build-id=none",
    ...(build.linkerScript === undefined
      ? []
      : [
          `-Wl,-T,${fileURLToPath(new URL(build.linkerScript, import.meta.url))}`,
          // ESP-IDF's reservation overlaps the code it reserves by design.
          "-Wl,--no-check-sections",
        ]),
    ...sources,
    "-o",
    path,
  ];
  const options = { timeout: 10000, maxBuffer: 1024 * 1024 };
  const compilerVersion = await run(compiler, ["--version"], options);
  const linkerVersion = await run(linker, ["--version"], options);
  const readerVersion = await run(reader, ["--version"], options);
  await run(compiler, args, { ...options, timeout: 60000 });
  const elf = await readRiscvElf(reader, path, floatAbi, run);
  assert.equal(elf.class, `ELF${bits}`);
  assert.match(elf.data, /little endian/u);
  assert.match(elf.type, pie ? /^DYN\b/u : /^EXEC\b/u);
  if (pie) {
    assert.match(
      elf.stdout,
      /^\s*INTERP\b/mu,
      "Expected PT_INTERP program header in PIE fixture",
    );
  } else {
    assert.doesNotMatch(
      elf.stdout,
      /^\s*INTERP\b/mu,
      "Unexpected PT_INTERP program header in static ET_EXEC fixture",
    );
  }
  assert.match(elf.machine, /^RISC-V\b/u);
  assert.equal(
    elf.flags,
    build.flags,
    `Compiler did not declare RVC and the ${floatAbi}-float ABI`,
  );
  assert.equal(elf.isa.xlen, bits);
  // Every source-owned global; the verifier asserts the ones it needs.
  const symbols = {};
  for (const [, value, name] of elf.stdout.matchAll(
    /^\s*\d+:\s+([\da-f]+)\s+\d+\s+(?:FUNC|OBJECT)\s+GLOBAL\s+\S+\s+\d+\s+(rea_riscv_\w+)\s*$/gmu,
  )) {
    assert.equal(symbols[name], undefined, `Ambiguous readelf symbol ${name}`);
    symbols[name] = `0x${BigInt(`0x${value}`).toString(16)}`;
  }
  // Linker-script symbols, with the section index or ABS that readelf reports.
  const linkerSymbols = {};
  for (const [, value, section, name] of elf.stdout.matchAll(
    /^\s*\d+:\s+([\da-f]+)\s+0\s+NOTYPE\s+GLOBAL\s+\S+\s+(ABS|\d+)\s+(_\w+)\s*$/gmu,
  )) {
    assert.equal(linkerSymbols[name], undefined, `Ambiguous symbol ${name}`);
    linkerSymbols[name] = {
      address: `0x${BigInt(`0x${value}`).toString(16)}`,
      section: section === "ABS" ? section : Number(section),
    };
  }
  return {
    path,
    sha256: await sha256(path),
    riscv: {
      elfClass: bits,
      byteOrder: "little",
      type: pie ? 3 : 2,
      flags: elf.flags,
      isa: elf.isa,
      ...(pie ? { hasInterpreter: true } : {}),
      sectionOverlap: sectionOverlapOf(elf.sections),
    },
    symbols,
    linkerSymbols,
    sections: elf.sections,
    toolchain: {
      compiler: { command: compiler, version: compilerVersion.stdout.trim() },
      linker: { command: linker, version: linkerVersion.stdout.trim() },
      reader: { command: reader, version: readerVersion.stdout.trim() },
      arguments: args,
    },
    sources: await Promise.all(
      sources.map(async (sourcePath) => ({
        path: sourcePath,
        sha256: await sha256(sourcePath),
      })),
    ),
  };
}

/**
 * Link the same objects again without symbols or DWARF. Every allocated
 * section must keep its address and bytes, so the typed build's symbol
 * addresses locate the same code in the stripped image.
 */
export async function stripRiscvFixture(directory, typed, run = execute) {
  const path = join(
    directory,
    typed.path.split("/").at(-1).replace(".elf", "-stripped.elf"),
  );
  const args = [
    ...typed.toolchain.arguments.slice(0, -2),
    "-Wl,--strip-all",
    "-o",
    path,
  ];
  await run(typed.toolchain.compiler.command, args, {
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
  const elf = await readRiscvElf(
    typed.toolchain.reader.command,
    path,
    "soft",
    run,
  );
  assert.equal(elf.flags, typed.riscv.flags);
  assert.deepEqual(elf.isa, typed.riscv.isa);
  assert.ok(
    !elf.sections.some(
      (section) =>
        section.name === ".symtab" || section.name.startsWith(".debug"),
    ),
    "Stripped fixture still carries symbols or DWARF",
  );
  const allocated = (sections) =>
    sections
      .filter((section) => section.allocated)
      .map(({ name, address, size }) => ({ name, address, size }));
  assert.deepEqual(allocated(elf.sections), allocated(typed.sections));
  const [typedBytes, strippedBytes] = await Promise.all([
    readFile(typed.path),
    readFile(path),
  ]);
  for (const section of elf.sections.filter((value) => value.allocated)) {
    if (section.type === "NOBITS") continue;
    const twin = typed.sections.find((value) => value.name === section.name);
    assert.ok(
      strippedBytes
        .subarray(section.offset, section.offset + section.size)
        .equals(typedBytes.subarray(twin.offset, twin.offset + twin.size)),
      `Stripped ${section.name} bytes differ from the typed build`,
    );
  }
  return {
    ...typed,
    path,
    sha256: await sha256(path),
    stripped: true,
    sections: elf.sections,
    toolchain: { ...typed.toolchain, arguments: args },
  };
}
