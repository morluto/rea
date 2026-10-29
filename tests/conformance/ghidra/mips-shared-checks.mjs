import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseMipsReadelf } from "./mips-checks.mjs";

const execute = promisify(execFile);
const RELOCATION_TYPES = new Map([
  [0, "R_MIPS_NONE"],
  [3, "R_MIPS_REL32"],
  [38, "R_MIPS_TLS_DTPMOD32"],
  [39, "R_MIPS_TLS_DTPREL32"],
  [47, "R_MIPS_TLS_TPREL32"],
]);
const TLS = new Set([38, 39, 47]);
const hex = (value) => `0x${value.toString(16)}`;
const plain = (name) => name.replace(/@.*$/u, "");

/** Parse GNU `readelf -l -d -r --dyn-syms -W` program, dynamic, REL and symbol facts. */
export function parseMipsSharedReadelf(text) {
  const loads = [
    ...text.matchAll(
      /^\s*LOAD\s+0x([\da-f]+)\s+0x([\da-f]+)\s+0x[\da-f]+\s+0x([\da-f]+)\s+0x([\da-f]+)\s/gmu,
    ),
  ].map((match) => ({
    offset: Number.parseInt(match[1], 16),
    address: Number.parseInt(match[2], 16),
    fileSize: Number.parseInt(match[3], 16),
    memorySize: Number.parseInt(match[4], 16),
  }));
  assert.ok(loads.length > 0, "Missing readelf PT_LOAD headers");
  // readelf prints addresses as 0x-prefixed hex and counts as decimal.
  const dynamic = new Map();
  for (const match of text.matchAll(
    /^\s*0x[\da-f]+\s+\((\w+)\)\s+(0x[\da-f]+|\d+)\b/gmu,
  )) {
    assert.ok(!dynamic.has(match[1]), `Duplicate dynamic tag ${match[1]}`);
    dynamic.set(match[1], Number(match[2]));
  }
  for (const tag of [
    "PLTGOT",
    "MIPS_LOCAL_GOTNO",
    "MIPS_GOTSYM",
    "MIPS_SYMTABNO",
  ])
    assert.ok(dynamic.has(tag), `Missing dynamic tag ${tag}`);
  const symbols = new Map();
  const table = text.match(
    /^Symbol table '\.dynsym' contains (\d+) entries:\n[^\n]*\n((?:\s*\d+:.*\n?)*)/mu,
  );
  assert.ok(table, "Missing readelf .dynsym table");
  for (const match of table[2].matchAll(
    /^\s*(\d+):\s+([\da-f]{8})\s+\d+\s+(\w+)\s+(\w+)\s+\S+\s+(UND|ABS|\d+)(?:[ \t]+(\S+))?/gmu,
  ))
    symbols.set(Number(match[1]), {
      index: Number(match[1]),
      value: Number.parseInt(match[2], 16),
      type: match[3],
      ndx: match[5],
      name: plain(match[6] ?? ""),
    });
  assert.equal(symbols.size, Number(table[1]), "readelf .dynsym entry count");
  const relocations = [];
  const headers = [
    ...text.matchAll(
      /^Relocation section '(\S+)' at offset 0x[\da-f]+ contains (\d+) entr(?:y|ies):$/gmu,
    ),
  ];
  for (const [position, header] of headers.entries()) {
    const body = text.slice(
      (header.index ?? 0) + header[0].length,
      headers[position + 1]?.index ?? text.length,
    );
    const entries = [
      ...body.matchAll(/^([\da-f]{8})\s+([\da-f]{8})\s+(R_MIPS_\S+)/gmu),
    ].map((match) => {
      const info = Number.parseInt(match[2], 16);
      const type = info & 0xff;
      assert.equal(
        match[3],
        RELOCATION_TYPES.get(type) ?? match[3],
        "readelf relocation name disagrees with r_info",
      );
      return {
        address: Number.parseInt(match[1], 16),
        type,
        symbolIndex: info >>> 8,
      };
    });
    assert.equal(entries.length, Number(header[2]), `${header[1]} entry count`);
    relocations.push(...entries);
  }
  return { loads, dynamic, symbols, relocations };
}

/** Independent reader is a bounded test prerequisite, never an REA provider. */
export async function inspectMipsSharedReadelf(path, byteOrder, floatAbi) {
  const command = process.env.REA_MIPS_READELF ?? "readelf";
  const options = {
    env: { ...process.env, LC_ALL: "C" },
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
  };
  const version = await execute(command, ["--version"], options);
  assert.match(
    version.stdout,
    /^GNU readelf\b/u,
    "This lane requires GNU readelf",
  );
  const result = await execute(
    command,
    ["-h", "-A", "-S", "-l", "-d", "-r", "--dyn-syms", "-W", path],
    options,
  );
  assert.equal(
    result.stderr.trim(),
    "",
    `readelf diagnostics: ${result.stderr}`,
  );
  return {
    ...parseMipsReadelf(result.stdout, byteOrder, floatAbi, "dyn"),
    ...parseMipsSharedReadelf(result.stdout),
    command,
    version: version.stdout.split("\n")[0],
  };
}

/**
 * Ghidra places the image at one constant delta from its link addresses;
 * every file-backed block inside a PT_LOAD must agree on it.
 */
export function mipsSharedPlacementDelta(facts, mappings) {
  let delta;
  for (const block of mappings) {
    if (block.file_offset === null || !/^0x[\da-f]+$/u.test(block.start))
      continue;
    const load = facts.loads.find(
      (item) =>
        block.file_offset >= item.offset &&
        block.file_offset + block.length <= item.offset + item.fileSize,
    );
    if (load === undefined) continue;
    const placed =
      BigInt(block.start) -
      BigInt(load.address + block.file_offset - load.offset);
    if (delta === undefined) delta = placed;
    assert.equal(placed, delta, `Placement delta of ${block.block}`);
  }
  assert.ok(
    delta !== undefined,
    "No file-backed Ghidra block inside a PT_LOAD",
  );
  return delta;
}

/**
 * Recompute every dynamic relocation and GOT entry from the source file and
 * GNU readelf, then require Ghidra's loaded words to match. REL32 encodes
 * A + S (S = delta for symbol zero, the symbol's placed address otherwise, or
 * its EXTERNAL block address when it is undefined). Global GOT entries hold
 * their symbol's placed address, except that an undefined function with a
 * nonzero value (its .MIPS.stubs lazy-binding stub) holds that value plus
 * delta, as glibc's elf_machine_got_rel sets it before the first call. Local
 * entries hold their original word plus delta. TLS slots stay unapplied.
 */
export function assertMipsSharedLoad({
  facts,
  fileBytes,
  mappings,
  ghidraRelocations,
  words,
  names,
  byteOrder,
}) {
  const read32 = (buffer, offset) =>
    byteOrder === "little"
      ? buffer.readUInt32LE(offset)
      : buffer.readUInt32BE(offset);
  const fileOffset = (address) => {
    const load = facts.loads.find(
      (item) =>
        address >= item.address && address + 4 <= item.address + item.fileSize,
    );
    assert.ok(load, `No file-backed PT_LOAD for ${hex(address)}`);
    return load.offset + address - load.address;
  };
  const delta = mipsSharedPlacementDelta(facts, mappings);
  // Images without imports (the dynamic linker itself) have no EXTERNAL block.
  const external = mappings.filter((item) => item.block === "EXTERNAL");
  assert.ok(external.length <= 1, "At most one Ghidra EXTERNAL block");
  const symbolAddress = (index) => {
    const symbol = facts.symbols.get(index);
    assert.ok(symbol, `Dynamic symbol ${index} missing from readelf`);
    if (symbol.ndx === "UND") {
      assert.equal(
        external.length,
        1,
        `Ghidra EXTERNAL block for ${symbol.name}`,
      );
      const externalStart = BigInt(external[0].start);
      const externalEnd = externalStart + BigInt(external[0].length);
      const found = names.filter(
        (item) =>
          item.symbol?.external === false &&
          plain(item.value.replace(/^<EXTERNAL>::/u, "")) === symbol.name &&
          BigInt(item.address) >= externalStart &&
          BigInt(item.address) < externalEnd,
      );
      assert.equal(found.length, 1, `External placement of ${symbol.name}`);
      return { address: BigInt(found[0].address), external: true };
    }
    if (symbol.ndx === "ABS")
      return { address: BigInt(symbol.value), external: false };
    return { address: BigInt(symbol.value) + delta, external: false };
  };
  const loaded = (address) => {
    const word = words.get(address);
    assert.ok(word !== undefined, `Loaded word at ${hex(address)}`);
    return BigInt(word);
  };
  const reported = new Map();
  for (const item of ghidraRelocations) {
    if (!/^0x[\da-f]+$/u.test(item.address)) continue;
    const key = `${BigInt(item.address)}:${item.type}`;
    reported.set(key, item);
  }
  const coverage = {
    rel32_local: 0,
    rel32_defined: 0,
    rel32_external: 0,
    tls: 0,
    got_local: 0,
    got_local_zero: 0,
    got_defined: 0,
    got_external: 0,
    got_lazy_stub: 0,
    got_skipped_tls: 0,
  };
  for (const relocation of facts.relocations) {
    if (relocation.type === 0) continue;
    const place = BigInt(relocation.address) + delta;
    const ghidra = reported.get(`${place}:${relocation.type}`);
    assert.ok(ghidra, `Ghidra relocation ${relocation.type} at ${hex(place)}`);
    const original = BigInt(read32(fileBytes, fileOffset(relocation.address)));
    if (TLS.has(relocation.type)) {
      // Module index and TLS offsets exist only in a running process.
      assert.equal(ghidra.status, "UNSUPPORTED", `TLS status at ${hex(place)}`);
      assert.equal(
        loaded(place),
        original,
        `TLS slot at ${hex(place)} changed`,
      );
      coverage.tls += 1;
      continue;
    }
    assert.equal(
      relocation.type,
      3,
      `Unexpected relocation ${relocation.type}`,
    );
    assert.equal(ghidra.status, "APPLIED", `REL32 status at ${hex(place)}`);
    let expected;
    if (relocation.symbolIndex === 0) {
      expected = original + delta;
      coverage.rel32_local += 1;
    } else {
      const target = symbolAddress(relocation.symbolIndex);
      expected = original + target.address;
      if (target.external) coverage.rel32_external += 1;
      else coverage.rel32_defined += 1;
    }
    assert.equal(
      loaded(place),
      expected & 0xffffffffn,
      `REL32 at ${hex(place)} (symbol ${relocation.symbolIndex})`,
    );
  }
  const got = facts.dynamic.get("PLTGOT");
  const localCount = facts.dynamic.get("MIPS_LOCAL_GOTNO");
  const firstGlobal = facts.dynamic.get("MIPS_GOTSYM");
  const globalCount = facts.dynamic.get("MIPS_SYMTABNO") - firstGlobal;
  // Entry 0 is the lazy resolver; entry 1 is the GNU module pointer when its MSB is set.
  const reserved =
    localCount > 1 &&
    (read32(fileBytes, fileOffset(got + 4)) & 0x80000000) !== 0
      ? 2
      : 1;
  for (let index = reserved; index < localCount; index += 1) {
    const address = got + index * 4;
    const place = BigInt(address) + delta;
    const original = BigInt(read32(fileBytes, fileOffset(address)));
    assert.equal(loaded(place), original + delta, `Local GOT entry ${index}`);
    coverage.got_local += 1;
    if (original === 0n) coverage.got_local_zero += 1;
  }
  for (let offset = 0; offset < globalCount; offset += 1) {
    const index = localCount + offset;
    const symbol = facts.symbols.get(firstGlobal + offset);
    assert.ok(symbol, `GOT symbol ${firstGlobal + offset}`);
    if (symbol.type === "TLS") {
      coverage.got_skipped_tls += 1;
      continue;
    }
    const place = BigInt(got + index * 4) + delta;
    if (symbol.ndx === "UND" && symbol.type === "FUNC" && symbol.value !== 0) {
      assert.equal(
        loaded(place),
        (BigInt(symbol.value) + delta) & 0xffffffffn,
        `Global GOT entry ${index} for ${symbol.name} (lazy stub)`,
      );
      coverage.got_lazy_stub += 1;
      continue;
    }
    const target = symbolAddress(symbol.index);
    assert.equal(
      loaded(place),
      target.address & 0xffffffffn,
      `Global GOT entry ${index} for ${symbol.name}`,
    );
    if (target.external) coverage.got_external += 1;
    else coverage.got_defined += 1;
  }
  return { delta: hex(delta), ...coverage };
}
