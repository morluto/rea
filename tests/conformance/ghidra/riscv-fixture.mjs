import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FIXTURE_TOOLS, fixtureCommand } from "./fixture-toolchain.mjs";

const execute = promisify(execFile);

const FLOAT_ABI_SOURCES = [
  "../c/riscv-float-abi.c",
  "./riscv-probe.S",
  "./riscv-isa-probe.S",
];

/** One build per float ABI the lane verifies. */
const BUILDS = {
  double: {
    sources: ["../c/riscv.c", "./riscv-probe.S"],
    march: (bits) => `rv${bits}imafdc`,
    mabi: (bits) => (bits === 32 ? "ilp32d" : "lp64d"),
    flags: 5,
  },
  // ESP-IDF's ESP32-C2 and C3 base string, built ilp32 as ESP-IDF does.
  soft: {
    sources: FLOAT_ABI_SOURCES,
    march: () => "rv32imc_zicsr_zifencei",
    mabi: () => "ilp32",
    flags: 1,
  },
  // ESP-IDF 5.5's ESP32-H4 base string, built ilp32f as ESP-IDF does.
  single: {
    sources: FLOAT_ABI_SOURCES,
    march: () => "rv32imafc_zicsr_zifencei",
    mabi: () => "ilp32f",
    flags: 3,
  },
  // The same build with the shapes __rea_ilp32f cannot express.
  unmodelled: {
    sources: [...FLOAT_ABI_SOURCES, "../c/riscv-float-abi-empty.cpp"],
    march: () => "rv32imafc_zicsr_zifencei",
    mabi: () => "ilp32f",
    defines: ["REA_RISCV_ABI_UNMODELLED"],
    flags: 3,
  },
};

const readerOptions = {
  env: { ...process.env, LC_ALL: "C" },
  timeout: 10000,
  maxBuffer: 1024 * 1024,
};

/** Independent reading of LLVM readelf's `-h -l -S -s -A` report. */
const readRiscvElf = async (reader, path, run = execute) => {
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
      /^\s*\[\s*\d+\]\s+(\S+)\s+(\S+)\s+([\da-f]+)\s+([\da-f]+)\s+([\da-f]+)\s+[\da-f]+\s+(\S*)\s+\d+\s+\d+\s+\d+\s*$/gmu,
    ),
  ].map(([, name, type, address, offset, size, flags]) => ({
    name,
    type,
    address: Number.parseInt(address, 16),
    offset: Number.parseInt(offset, 16),
    size: Number.parseInt(size, 16),
    allocated: flags.includes("A"),
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
  };
};

const sha256 = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/**
 * Build and independently inspect a source-owned ELF; never execute it. The
 * variant is a float ABI, or `unmodelled` for the refused single-float build.
 */
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
    "-Wl,-e,rea_riscv_entry",
    "-Wl,--build-id=none",
    ...(build.defines ?? []).map((name) => `-D${name}`),
    ...sources,
    "-o",
    path,
  ];
  const options = { timeout: 10000, maxBuffer: 1024 * 1024 };
  const compilerVersion = await run(compiler, ["--version"], options);
  const linkerVersion = await run(linker, ["--version"], options);
  const readerVersion = await run(reader, ["--version"], options);
  await run(compiler, args, { ...options, timeout: 60000 });
  const elf = await readRiscvElf(reader, path, run);
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
    `Compiler did not declare RVC and the ${variant} build's float ABI`,
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
  return {
    variant,
    path,
    sha256: await sha256(path),
    riscv: {
      elfClass: bits,
      byteOrder: "little",
      type: pie ? 3 : 2,
      flags: elf.flags,
      isa: elf.isa,
      ...(pie ? { hasInterpreter: true } : {}),
    },
    symbols,
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
  const elf = await readRiscvElf(typed.toolchain.reader.command, path, run);
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

const DW_AT_language = 0x13;
const DW_TAG_compile_unit = 0x11;
/** Fixed value sizes of the DWARF 4 and 5 forms a 32-bit unit may use. */
const FIXED_FORM_BYTES = new Map([
  [0x05, 2],
  [0x06, 4],
  [0x07, 8],
  [0x0b, 1],
  [0x0c, 1],
  [0x0e, 4],
  [0x10, 4],
  [0x11, 1],
  [0x12, 2],
  [0x13, 4],
  [0x14, 8],
  [0x17, 4],
  [0x19, 0],
  [0x1c, 4],
  [0x1d, 4],
  [0x1e, 16],
  [0x1f, 4],
  [0x20, 8],
  [0x21, 0],
  [0x25, 1],
  [0x26, 2],
  [0x27, 3],
  [0x28, 4],
  [0x29, 1],
  [0x2a, 2],
  [0x2b, 3],
  [0x2c, 4],
]);
// Forms whose value is one ULEB128 or SLEB128 number.
const LEB_FORMS = new Set([0x0d, 0x0f, 0x15, 0x1a, 0x1b, 0x22, 0x23]);
// Forms whose ULEB128 length precedes that many bytes.
const BLOCK_FORMS = new Set([0x09, 0x18]);

const leb = (bytes, at, end) => {
  let value = 0;
  let shift = 0;
  for (let cursor = at; cursor < end; cursor += 1) {
    value += (bytes[cursor] & 0x7f) * 2 ** shift;
    shift += 7;
    if ((bytes[cursor] & 0x80) === 0) return { value, next: cursor + 1 };
    assert.ok(shift < 49, "DWARF LEB128 value is too long");
  }
  assert.fail("Truncated DWARF LEB128 value");
};

/**
 * Rewrite the DW_AT_language of every C compile unit, so the same code reads
 * as another language; assembly units keep theirs. Only 32-bit DWARF 4 and 5
 * units with a data1 or data2 language are rewritten, and any other shape
 * fails, because each value offset is computed from the unit's abbreviations.
 */
export async function relabelRiscvFixtureLanguage(directory, typed, language) {
  const path = join(
    directory,
    typed.path.split("/").at(-1).replace(".elf", `-lang-${language}.elf`),
  );
  const bytes = Buffer.from(await readFile(typed.path));
  const section = (name) => {
    const found = typed.sections.filter((value) => value.name === name);
    assert.equal(found.length, 1, `Fixture has no single ${name} section`);
    const [{ offset, size }] = found;
    assert.ok(offset + size <= bytes.length, `${name} lies outside the file`);
    return { start: offset, end: offset + size };
  };
  const info = section(".debug_info");
  const abbrev = section(".debug_abbrev");
  /** The attribute forms of the compile-unit abbreviation at this offset. */
  const unitForms = (offset, code) => {
    let at = abbrev.start + offset;
    for (;;) {
      const entry = leb(bytes, at, abbrev.end);
      assert.notEqual(entry.value, 0, "Compile-unit abbreviation not found");
      const tag = leb(bytes, entry.next, abbrev.end);
      at = tag.next + 1; // DW_CHILDREN_*
      const attributes = [];
      for (;;) {
        const name = leb(bytes, at, abbrev.end);
        const form = leb(bytes, name.next, abbrev.end);
        at = form.next;
        if (form.value === 0x21) at = leb(bytes, at, abbrev.end).next;
        if (name.value === 0 && form.value === 0) break;
        attributes.push({ name: name.value, form: form.value });
      }
      if (entry.value === code) {
        assert.equal(tag.value, DW_TAG_compile_unit, "First DIE is not a unit");
        return attributes;
      }
    }
  };
  const relabelled = [];
  for (let unit = info.start; unit < info.end;) {
    const length = bytes.readUInt32LE(unit);
    assert.ok(length < 0xfffffff0, "64-bit DWARF units are not rewritten");
    const end = unit + 4 + length;
    assert.ok(end <= info.end, "DWARF unit overruns .debug_info");
    const version = bytes.readUInt16LE(unit + 4);
    assert.ok(version === 4 || version === 5, `DWARF ${version} unit`);
    const abbrevOffset = bytes.readUInt32LE(unit + (version === 5 ? 8 : 6));
    const addressSize = bytes[unit + (version === 5 ? 7 : 10)];
    if (version === 5)
      assert.equal(
        bytes[unit + 6],
        1,
        "Only DW_UT_compile units are rewritten",
      );
    let at = unit + (version === 5 ? 12 : 11);
    const code = leb(bytes, at, end);
    at = code.next;
    for (const { name, form } of unitForms(abbrevOffset, code.value)) {
      if (name === DW_AT_language) {
        assert.ok(
          form === 0x0b || form === 0x05,
          `DW_AT_language form ${form}`,
        );
        const read = form === 0x0b ? bytes[at] : bytes.readUInt16LE(at);
        // C89, C, C99, C11 and C17; assembly (0x8001) keeps its label.
        if ([0x01, 0x02, 0x0c, 0x1d, 0x2c].includes(read)) {
          assert.ok(form === 0x05 || language <= 0xff, "Language does not fit");
          if (form === 0x0b) bytes[at] = language;
          else bytes.writeUInt16LE(language, at);
          relabelled.push({ unit: unit - info.start, from: read });
        }
        break;
      }
      if (form === 0x01) at += addressSize;
      else if (form === 0x08) at = bytes.indexOf(0, at) + 1;
      else if (form === 0x0a) at += 1 + bytes[at];
      else if (LEB_FORMS.has(form)) at = leb(bytes, at, end).next;
      else if (BLOCK_FORMS.has(form)) {
        const size = leb(bytes, at, end);
        at = size.next + size.value;
      } else {
        assert.ok(FIXED_FORM_BYTES.has(form), `Unhandled DWARF form ${form}`);
        at += FIXED_FORM_BYTES.get(form);
      }
      assert.ok(at > 0 && at <= end, "DWARF attribute overruns its unit");
    }
    unit = end;
  }
  assert.ok(relabelled.length > 0, "Fixture has no C compile unit to relabel");
  await writeFile(path, bytes);
  return {
    ...typed,
    path,
    sha256: await sha256(path),
    relabelled: { language, units: relabelled },
  };
}
