/** Compare binary hardening rows with host toolchains when they exist. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importVerifierSource } from "./lib/verifier-source-loader.mjs";

const { readElfHardening } = await importVerifierSource(
  "../src/native/hardening/ElfHardening.ts",
  import.meta.url,
);
const { readMachoHardening } = await importVerifierSource(
  "../src/native/hardening/MachoHardening.ts",
  import.meta.url,
);
const { readPeHardening } = await importVerifierSource(
  "../src/native/hardening/PeHardening.ts",
  import.meta.url,
);
const { peHardeningImage } = await importVerifierSource(
  "../src/native/hardening/BinaryHardening.fixture.ts",
  import.meta.url,
);

const which = (command) => {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};

const xcrunFind = (name) => {
  const result = spawnSync("xcrun", ["--find", name], { encoding: "utf8" });
  return {
    name,
    status: result.status,
    path: result.status === 0 ? result.stdout.trim() : null,
    stderr: (result.stderr ?? "").trim().slice(0, 240),
  };
};

const findTool = (name) => which(name) ?? xcrunFind(name).path;

const versionLine = (command, args = ["--version"]) => {
  const result = run(command, args);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .trim()
    .split("\n")[0]
    ?.slice(0, 240);
};

const run = (command, args, options = {}) =>
  spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120000,
    ...options,
  });

const statesOf = (rows) =>
  Object.fromEntries(rows.map((row) => [row.property, row.state]));

const report = {
  host: `${process.platform} ${process.arch}`,
  node: process.version,
  npm: versionLine("npm", ["-v"]),
  xcrun: ["readelf", "llvm-readelf", "clang", "gcc", "cc", "ld"].map(xcrunFind),
  unavailable: [],
  checks: [],
};

const synthetic = peHardeningImage();
const peImage = await readPeHardening(synthetic, {
  path: "/artifacts/synthetic.exe",
  sha256: "a".repeat(64),
  bytes: synthetic.length,
});
const peStates = statesOf(peImage.rows);
assert.equal(peStates.dynamic_base, "enabled");
assert.equal(peStates.high_entropy_va, "enabled");
assert.equal(peStates.nx_compat, "enabled");
assert.equal(peStates.force_integrity, "disabled");
assert.equal(peStates.no_seh, "disabled");
assert.equal(peStates.guard_cf, "enabled");
assert.equal(peStates.cfg_instrumented, "enabled");
assert.equal(peStates.authenticode_present, "disabled");
assert.equal(peStates.debug_record_present, "disabled");
report.checks.push({
  kind: "synthetic-pe",
  bits: peImage.bits,
  states: peStates,
});

const source = `int main(void) {
  volatile char buf[64];
  buf[0] = 1;
  return (int)buf[0];
}
`;

const root = await mkdtemp(join(tmpdir(), "rea-binary-hardening-"));
try {
  const cFile = join(root, "sample.c");
  await writeFile(cFile, source);
  await verifyElf(root, cFile, report);
  await verifyMacho(root, cFile, report);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));

function compilerCandidate(name, command, prefix, versionArgs = ["--version"]) {
  const located = findTool(command);
  if (located === null) return null;
  return { name, command: located, prefix, versionArgs };
}

async function verifyElf(directory, cFile, output) {
  const readelf = findTool("readelf") ?? findTool("llvm-readelf");
  const compilers = [
    compilerCandidate("x86_64-linux-gnu-gcc", "x86_64-linux-gnu-gcc", []),
    compilerCandidate("aarch64-linux-gnu-gcc", "aarch64-linux-gnu-gcc", []),
    compilerCandidate("musl-gcc", "musl-gcc", []),
    compilerCandidate("gcc", "gcc", []),
    compilerCandidate("clang-linux-gnu", "clang", [
      "--target=x86_64-linux-gnu",
    ]),
    compilerCandidate("clang-linux-musl", "clang", [
      "--target=x86_64-linux-musl",
    ]),
    compilerCandidate(
      "zig-linux-gnu",
      "zig",
      ["cc", "-target", "x86_64-linux-gnu"],
      ["version"],
    ),
    compilerCandidate(
      "zig-linux-musl",
      "zig",
      ["cc", "-target", "x86_64-linux-musl"],
      ["version"],
    ),
  ].filter((candidate) => candidate !== null);
  output.tools = {
    ...(output.tools ?? {}),
    readelf,
    readelfVersion:
      readelf === null ? null : versionLine(readelf, ["--version"]),
    compilers: compilers.map((compiler) => ({
      name: compiler.name,
      command: compiler.command,
      version: versionLine(compiler.command, compiler.versionArgs),
    })),
  };
  if (compilers.length === 0) {
    output.unavailable.push({
      kind: "elf",
      reason:
        "No x86_64-linux-gnu-gcc, aarch64-linux-gnu-gcc, musl-gcc, gcc, clang, or zig was found.",
      compilers: [],
      readelf,
    });
    return;
  }
  if (readelf === null)
    output.unavailable.push({
      kind: "elf-readelf",
      reason:
        "No readelf or llvm-readelf was found. Compiled ELF images are still parsed.",
      readelf: null,
    });
  const variants = [
    { name: "pie", flags: ["-fPIE", "-pie"] },
    { name: "no-pie", flags: ["-fno-pie", "-no-pie"] },
    { name: "relro-now", flags: ["-fPIE", "-pie", "-Wl,-z,relro,-z,now"] },
    { name: "relro", flags: ["-fPIE", "-pie", "-Wl,-z,relro,-z,lazy"] },
    { name: "no-relro", flags: ["-fPIE", "-pie", "-Wl,-z,norelro"] },
    {
      name: "stack-protector",
      flags: ["-fPIE", "-pie", "-fstack-protector-strong"],
    },
    { name: "execstack", flags: ["-fPIE", "-pie", "-Wl,-z,execstack"] },
    { name: "build-id", flags: ["-fPIE", "-pie", "-Wl,--build-id=sha1"] },
    { name: "dynamic", flags: ["-fPIE", "-pie", "-dynamic"] },
    { name: "two-needed", twoNeeded: true },
  ];
  for (const variant of variants) {
    let met = false;
    for (const compiler of compilers) {
      const binary = join(directory, `${compiler.name}-${variant.name}`);
      const compiled = variant.twoNeeded
        ? await compileTwoNeeded(compiler, directory, binary)
        : run(compiler.command, [
            ...compiler.prefix,
            ...variant.flags,
            cFile,
            "-o",
            binary,
          ]);
      if (compiled.status !== 0) {
        output.checks.push({
          kind: "elf-compile-skipped",
          compiler: compiler.name,
          variant: variant.name,
          status: compiled.status,
          stderr: (compiled.stderr ?? "").slice(0, 400),
        });
        continue;
      }
      const header = await readFile(binary);
      if (header.subarray(0, 4).toString("latin1") !== "\u007fELF") {
        output.checks.push({
          kind: "elf-compile-skipped",
          compiler: compiler.name,
          variant: variant.name,
          reason: "compiler did not emit ELF",
        });
        continue;
      }
      const observed = observeElfTags(header);
      let expected = null;
      let needed = observed.needed;
      let buildId = observed.buildId;
      if (readelf !== null) {
        const dumped = run(readelf, [
          "-h",
          "-l",
          "-d",
          "-S",
          "-s",
          "-n",
          binary,
        ]);
        if (dumped.status !== 0)
          throw new Error(
            `${readelf} failed for ${variant.name}: ${dumped.stderr}`,
          );
        expected = factsFromReadelf(dumped.stdout);
        needed = dumped.stdout.match(/\(NEEDED\)/g)?.length ?? 0;
        buildId = /Build ID|NT_GNU_BUILD_ID|GNU_BUILD_ID/i.test(dumped.stdout);
      }
      const image = readElfHardening(header);
      const actual = statesOf(image.rows);
      if (expected !== null)
        assertElf(actual, expected, `${compiler.name} ${variant.name}`);
      const satisfied = featureMet(variant.name, actual);
      output.checks.push({
        kind: "elf",
        compiler: compiler.name,
        variant: variant.name,
        bytes: header.length,
        readelf,
        expected,
        actual,
        needed,
        buildId,
        noteAlign: observed.noteAlign,
        featureMet: satisfied,
      });
      if (satisfied) {
        met = true;
        break;
      }
    }
    if (!met)
      output.unavailable.push({
        kind: "elf-feature",
        variant: variant.name,
        reason: unmetReason(variant.name),
      });
  }
}

async function compileTwoNeeded(compiler, directory, binary) {
  const libaSource = join(directory, "liba.c");
  const libbSource = join(directory, "libb.c");
  const mainSource = join(directory, "needed-main.c");
  await writeFile(libaSource, "int a_fn(void) { return 1; }\n");
  await writeFile(libbSource, "int b_fn(void) { return 2; }\n");
  await writeFile(
    mainSource,
    "int a_fn(void);\nint b_fn(void);\nint main(void) { return a_fn() + b_fn(); }\n",
  );
  const liba = join(directory, "liba.so");
  const libb = join(directory, "libb.so");
  const first = run(compiler.command, [
    ...compiler.prefix,
    "-shared",
    "-fPIC",
    libaSource,
    "-o",
    liba,
  ]);
  if (first.status !== 0) return first;
  const second = run(compiler.command, [
    ...compiler.prefix,
    "-shared",
    "-fPIC",
    libbSource,
    "-o",
    libb,
  ]);
  if (second.status !== 0) return second;
  return run(compiler.command, [
    ...compiler.prefix,
    "-fPIE",
    "-pie",
    "-dynamic",
    "-L",
    directory,
    "-la",
    "-lb",
    mainSource,
    "-o",
    binary,
  ]);
}

/** Count DT_NEEDED and a 36-byte GNU build-id note in a little-endian ELF. */
function observeElfTags(header) {
  const empty = { needed: null, buildId: false, noteAlign: [] };
  if (header.length < 52 || header[0] !== 0x7f || header[5] !== 1) return empty;
  const bits = header[4] === 2 ? 64 : header[4] === 1 ? 32 : 0;
  if (bits === 0) return empty;
  const u16 = (offset) => header.readUInt16LE(offset);
  const u32 = (offset) => header.readUInt32LE(offset);
  const u64 = (offset) => header.readBigUInt64LE(offset);
  const word = (offset) => (bits === 64 ? u64(offset) : BigInt(u32(offset)));
  const phoff = Number(bits === 64 ? u64(32) : u32(28));
  const shoff = Number(bits === 64 ? u64(40) : u32(32));
  const phentsize = u16(bits === 64 ? 54 : 42);
  const phnum = u16(bits === 64 ? 56 : 44);
  const shentsize = u16(bits === 64 ? 58 : 46);
  const shnum = u16(bits === 64 ? 60 : 48);
  let needed = null;
  if (
    phentsize > 0 &&
    phnum > 0 &&
    phoff >= 0 &&
    phoff + phnum * phentsize <= header.length
  ) {
    for (let index = 0; index < phnum; index += 1) {
      const at = phoff + index * phentsize;
      if (u32(at) !== 2) continue;
      needed ??= 0;
      const off = Number(bits === 64 ? u64(at + 8) : u32(at + 4));
      const size = Number(bits === 64 ? u64(at + 32) : u32(at + 16));
      const width = bits === 64 ? 16 : 8;
      if (off < 0 || size < 0 || off + size > header.length) continue;
      for (let cursor = 0; cursor + width <= size; cursor += width) {
        const tag = bits === 64 ? u64(off + cursor) : BigInt(u32(off + cursor));
        if (tag === 0n) break;
        if (tag === 1n) needed += 1;
      }
    }
  }
  const noteAlign = [];
  let buildId = false;
  if (
    shentsize > 0 &&
    shnum > 0 &&
    shoff >= 0 &&
    shoff + shnum * shentsize <= header.length
  ) {
    for (let index = 0; index < shnum; index += 1) {
      const at = shoff + index * shentsize;
      if (u32(at + 4) !== 7) continue;
      const off = Number(bits === 64 ? u64(at + 24) : u32(at + 16));
      const size = Number(word(bits === 64 ? at + 32 : at + 20));
      const align = word(bits === 64 ? at + 48 : at + 32);
      noteAlign.push(`${align.toString()}:${String(size)}`);
      if (off >= 0 && size >= 16 && off + 16 <= header.length) {
        const owner = header.subarray(off + 12, off + 16).toString("latin1");
        if (
          u32(off) === 4 &&
          u32(off + 4) === 20 &&
          u32(off + 8) === 3 &&
          owner.startsWith("GNU")
        )
          buildId = true;
      }
    }
  }
  return { needed, buildId, noteAlign };
}

function dynsymText(text) {
  const marker = "Symbol table '.dynsym'";
  const start = text.indexOf(marker);
  if (start < 0) return "";
  const rest = text.slice(start);
  const next = rest.indexOf("\nSymbol table ", marker.length);
  return next < 0 ? rest : rest.slice(0, next);
}

function featureMet(variant, actual) {
  if (variant === "execstack") return actual.nx === "disabled";
  if (variant === "stack-protector")
    return actual.stack_protector === "enabled";
  return true;
}

function unmetReason(variant) {
  if (variant === "execstack")
    return "No compiler emitted an ELF whose PT_GNU_STACK is executable, so NX disabled was not observed.";
  if (variant === "stack-protector")
    return "No compiler emitted an ELF with an undefined dynamic __stack_chk_fail, so stack_protector enabled was not observed.";
  return "No compiler emitted a readable ELF image for this variant.";
}

function factsFromReadelf(text) {
  const type = /Type:\s+(\S+)/.exec(text)?.[1] ?? "";
  const hasInterp = /\bINTERP\b/.test(text);
  const flags1 = /FLAGS_1\b[^\n]*/.exec(text)?.[0] ?? "";
  const stack = /GNU_STACK\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+([RWE]+)/i.exec(
    text,
  );
  const dynsym = dynsymText(text);
  return {
    type,
    pie: type === "DYN" && (hasInterp || /\bPIE\b/.test(flags1)),
    executable: type === "EXEC",
    nx: stack === null ? null : !stack[1].includes("E"),
    relro: /GNU_RELRO/.test(text),
    bindNow: /BIND_NOW/.test(text) || /\bNOW\b/.test(flags1),
    symtab: /\.symtab\b/.test(text),
    sectionHeaders: /Section Headers:/.test(text) && !/no sections/i.test(text),
    canary: dynsym
      .split("\n")
      .some(
        (line) => line.includes("__stack_chk_fail") && /\bUND\b/.test(line),
      ),
  };
}

function assertElf(actual, expected, label) {
  if (expected.executable) assert.equal(actual.pie, "disabled", label);
  else if (expected.pie) assert.equal(actual.pie, "enabled", label);
  else if (expected.type === "DYN")
    assert.equal(actual.pie, "not_applicable", label);
  if (expected.nx === null) assert.equal(actual.nx, "unknown", label);
  else assert.equal(actual.nx, expected.nx ? "enabled" : "disabled", label);
  if (!expected.relro) assert.equal(actual.relro, "disabled", label);
  else
    assert.equal(actual.relro, expected.bindNow ? "enabled" : "partial", label);
  assert.equal(
    actual.stack_protector,
    expected.canary ? "enabled" : "unknown",
    label,
  );
  if (!expected.sectionHeaders) assert.equal(actual.stripped, "unknown", label);
  else
    assert.equal(
      actual.stripped,
      expected.symtab ? "disabled" : "enabled",
      label,
    );
}

async function verifyMacho(directory, cFile, output) {
  const cc = findTool("cc") ?? findTool("clang");
  const otool = findTool("otool");
  if (cc === null) {
    output.unavailable.push({
      kind: "mach-o",
      reason: "No cc or clang was found.",
    });
    return;
  }
  const binary = join(directory, "macho");
  const compiled = run(cc, [
    "-arch",
    process.arch === "arm64" ? "arm64" : "x86_64",
    cFile,
    "-o",
    binary,
  ]);
  if (compiled.status !== 0) {
    output.unavailable.push({
      kind: "mach-o",
      reason: "cc did not emit a Mach-O image.",
      stderr: (compiled.stderr ?? "").slice(0, 400),
    });
    return;
  }
  const bytes = await readFile(binary);
  const images = await readMachoHardening(bytes);
  assert.ok(images.length >= 1);
  const pie = statesOf(images[0].rows).pie;
  let otoolPie = null;
  if (otool !== null) {
    const dumped = run(otool, ["-hv", binary]);
    if (dumped.status === 0) {
      otoolPie = /\bPIE\b/.test(dumped.stdout);
      if (otoolPie) assert.equal(pie, "enabled", "otool PIE");
    }
  }
  const otoolVersion = otool === null ? null : run(otool, ["-version"]);
  output.checks.push({
    kind: "mach-o",
    compiler: cc,
    ccVersion: versionLine(cc, ["--version"]),
    otool,
    otoolVersionStatus: otoolVersion?.status ?? null,
    otoolVersion:
      otoolVersion === null
        ? null
        : `${otoolVersion.stdout ?? ""}\n${otoolVersion.stderr ?? ""}`
            .trim()
            .slice(0, 400),
    images: images.length,
    pie,
    otoolPie,
    hardened_runtime: statesOf(images[0].rows).hardened_runtime,
  });
  const fat = join(directory, "fat");
  const universal = run(cc, [
    "-arch",
    "x86_64",
    "-arch",
    "arm64",
    cFile,
    "-o",
    fat,
  ]);
  if (universal.status !== 0) {
    output.unavailable.push({
      kind: "mach-o-universal",
      reason: "cc could not emit a universal Mach-O image.",
      stderr: (universal.stderr ?? "").slice(0, 400),
    });
    return;
  }
  const fatImages = await readMachoHardening(await readFile(fat));
  assert.equal(fatImages.length, 2);
  assert.ok(
    fatImages.every(
      (image) => image.status === "parsed" && image.slice !== null,
    ),
  );
  output.checks.push({
    kind: "mach-o-universal",
    slices: fatImages.map((image) => ({
      architecture: image.architecture,
      pie: statesOf(image.rows).pie,
    })),
  });
}
