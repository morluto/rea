import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/**
 * The ilp32 storage of each function in tests/conformance/c/riscv-float-abi.c,
 * as Ghidra prints it, with the words `rea_riscv_abi_caller`'s call site puts
 * there. Ghidra joins a register pair most-significant word first. A word is
 * an unsigned 32-bit value, "frame" for the address of a caller local, or
 * `{ frame: [...] }` for such an address whose memory holds those words. A
 * literal is how the typed caller's pseudocode should print the argument.
 */
const ILP32_FUNCTIONS = {
  rea_riscv_abi_pick: {
    return: ["float", "a0:4"],
    parameters: [
      ["a", "float", "a0:4", { a0: 0x3fc00000 }, "1.5"],
      ["b", "float", "a1:4", { a1: 0x40200000 }, "2.5"],
      ["sel", "int", "a2:4"],
    ],
  },
  rea_riscv_abi_wide: {
    return: ["double", "a1:4,a0:4"],
    parameters: [
      ["a", "double", "a1:4,a0:4", { a1: 0x400a0000, a0: 0 }, "3.25"],
      ["sel", "int", "a2:4"],
    ],
  },
  // A named double needs no aligned pair, so d starts in a1.
  rea_riscv_abi_mixed: {
    return: ["double", "a1:4,a0:4"],
    parameters: [
      ["i", "int", "a0:4"],
      ["d", "double", "a2:4,a1:4", { a2: 0x40130000, a1: 0 }, "4.75"],
      ["f", "float", "a3:4", { a3: 0x40b00000 }, "5.5"],
      ["e", "double", "a5:4,a4:4", { a5: 0x40188000, a4: 0 }, "6.125"],
    ],
  },
  // Only a7 is left for x: its low word goes there, its high word on the stack.
  rea_riscv_abi_split: {
    return: ["double", "a1:4,a0:4"],
    parameters: [
      ["a", "int", "a0:4", { a0: 1 }, "1"],
      ["b", "int", "a1:4", { a1: 2 }, "2"],
      ["c", "int", "a2:4", { a2: 3 }, "3"],
      ["d", "int", "a3:4", { a3: 4 }, "4"],
      ["e", "int", "a4:4", { a4: 5 }, "5"],
      ["f", "int", "a5:4", { a5: 6 }, "6"],
      ["g", "int", "a6:4"],
      [
        "x",
        "double",
        "Stack[0x0]:4,a7:4",
        { "Stack[0x0]": 0x401d0000, a7: 0 },
        "7.25",
      ],
    ],
  },
  // Two floats in 8 bytes: an integer pair, not fa0 and fa1.
  rea_riscv_abi_pair: {
    return: ["rea_riscv_abi_pair", "a1:4,a0:4"],
    parameters: [
      [
        "value",
        "rea_riscv_abi_pair",
        "a1:4,a0:4",
        { a1: 0x41180000, a0: 0x41080000 },
        "(rea_riscv_abi_pair)0x4118000041080000",
      ],
      ["scale", "float", "a2:4", { a2: 0x41280000 }, "10.5"],
    ],
  },
  rea_riscv_abi_tagged: {
    return: ["rea_riscv_abi_tagged", "a1:4,a0:4"],
    parameters: [
      [
        "value",
        "rea_riscv_abi_tagged",
        "a1:4,a0:4",
        { a1: 12, a0: 0x41380000 },
        "(rea_riscv_abi_tagged)0xc41380000",
      ],
      ["tag", "int", "a2:4"],
    ],
  },
  // Over 8 bytes: passed and returned through caller-allocated memory.
  rea_riscv_abi_large: {
    return: ["rea_riscv_abi_large *", "a0:4"],
    parameters: [
      [
        "__return_storage_ptr__",
        "rea_riscv_abi_large *",
        "a0:4 (auto)",
        { a0: "frame" },
      ],
      [
        "value",
        "rea_riscv_abi_large *",
        "a1:4",
        { a1: { frame: [0, 0x402b0000, 0, 0x402d0000, 0x41780000] } },
      ],
      ["scale", "float", "a2:4", { a2: 0x41840000 }, "16.5"],
    ],
  },
  // A long double is 16 bytes: passed and returned through caller memory too.
  rea_riscv_abi_quad: {
    return: ["long double *", "a0:4"],
    parameters: [
      [
        "__return_storage_ptr__",
        "long double *",
        "a0:4 (auto)",
        { a0: "frame" },
      ],
      [
        "value",
        "long double *",
        "a1:4",
        { a1: { frame: [0, 0, 0, 0x40036800] } },
      ],
      ["sel", "int", "a2:4"],
    ],
  },
  // Variadic doubles take aligned pairs, a2:a3 and a6:a7, so a1 and a5 are
  // skipped; the last int follows on the stack. Ghidra does not type them.
  rea_riscv_abi_variadic: {
    return: ["uint", "a0:4"],
    parameters: [["count", "int", "a0:4", { a0: 2 }, "2"]],
    variadic: {
      a2: 0,
      a3: 0x40318000,
      a6: 0,
      a7: 0x40328000,
      "Stack[0x0]": 19,
    },
  },
};

/**
 * The ilp32f storage of the same functions, plus the single-float-only ones
 * that `rea_riscv_abi_single_caller` calls. Floats of 32 bits or fewer take
 * fa0-fa7, a float and an integer split across both files, and anything
 * else uses the ilp32 convention. `stripped` records what Ghidra infers for
 * the stripped build where that differs: `parameters` when they are not one
 * word per typed location, and `return` when it is not the typed storage.
 */
const ILP32F_FUNCTIONS = {
  rea_riscv_abi_pick: {
    return: ["float", "fa0:4"],
    parameters: [
      ["a", "float", "fa0:4", { fa0: 0x3fc00000 }, "1.5"],
      ["b", "float", "fa1:4", { fa1: 0x40200000 }, "2.5"],
      ["sel", "int", "a0:4"],
    ],
  },
  rea_riscv_abi_wide: ILP32_FUNCTIONS.rea_riscv_abi_wide,
  rea_riscv_abi_mixed: {
    return: ["double", "a1:4,a0:4"],
    parameters: [
      ["i", "int", "a0:4"],
      ["d", "double", "a2:4,a1:4", { a2: 0x40130000, a1: 0 }, "4.75"],
      ["f", "float", "fa0:4", { fa0: 0x40b00000 }, "5.5"],
      ["e", "double", "a4:4,a3:4", { a4: 0x40188000, a3: 0 }, "6.125"],
    ],
  },
  rea_riscv_abi_split: ILP32_FUNCTIONS.rea_riscv_abi_split,
  rea_riscv_abi_pair: {
    return: ["rea_riscv_abi_pair", "fa1:4,fa0:4"],
    parameters: [
      [
        "value",
        "rea_riscv_abi_pair",
        "fa1:4,fa0:4",
        { fa1: 0x41180000, fa0: 0x41080000 },
        "(rea_riscv_abi_pair)0x4118000041080000",
      ],
      ["scale", "float", "fa2:4", { fa2: 0x41280000 }, "10.5"],
    ],
  },
  // The stripped function returns the float field in fa0 unchanged; Ghidra
  // recovers neither that return nor the parameter.
  rea_riscv_abi_tagged: {
    return: ["rea_riscv_abi_tagged", "a0:4,fa0:4"],
    parameters: [
      [
        "value",
        "rea_riscv_abi_tagged",
        "a0:4,fa0:4",
        { a0: 12, fa0: 0x41380000 },
        "(rea_riscv_abi_tagged)0xc41380000",
      ],
      ["tag", "int", "a1:4"],
    ],
    stripped: { return: "a0:4", parameters: ["a0:4", "a1:4"] },
  },
  rea_riscv_abi_large: {
    return: ["rea_riscv_abi_large *", "a0:4"],
    parameters: [
      [
        "__return_storage_ptr__",
        "rea_riscv_abi_large *",
        "a0:4 (auto)",
        { a0: "frame" },
      ],
      [
        "value",
        "rea_riscv_abi_large *",
        "a1:4",
        { a1: { frame: [0, 0x402b0000, 0, 0x402d0000, 0x41780000] } },
      ],
      ["scale", "float", "fa0:4", { fa0: 0x41840000 }, "16.5"],
    ],
  },
  rea_riscv_abi_quad: ILP32_FUNCTIONS.rea_riscv_abi_quad,
  rea_riscv_abi_variadic: ILP32_FUNCTIONS.rea_riscv_abi_variadic,
  // The integer part first, so the float takes the more significant word.
  // The stripped function changes only the flag: Ghidra recovers the byte it
  // returns in a0, not the float left in fa0.
  rea_riscv_abi_flagged: {
    caller: "rea_riscv_abi_single_caller",
    return: ["rea_riscv_abi_flagged", "fa0:4,a0:4"],
    parameters: [
      [
        "value",
        "rea_riscv_abi_flagged",
        "fa0:4,a0:4",
        { fa0: 0x41b40000, a0: 42 },
        "(rea_riscv_abi_flagged)0x41b400000000002a",
      ],
      ["scale", "float", "fa1:4", { fa1: 0x41bc0000 }, "23.5"],
    ],
    stripped: { return: "a0:1", parameters: ["fa0:4", "fa1:4", "a0:1"] },
  },
  // a to h fill fa0-fa7: value and z use integer registers. The stripped
  // function never reads a to g, and Ghidra infers no float parameters after
  // an unread one.
  rea_riscv_abi_fill: {
    caller: "rea_riscv_abi_single_caller",
    return: ["float", "fa0:4"],
    parameters: [
      ...[
        0x3f800000, 0x40000000, 0x40400000, 0x40800000, 0x40a00000, 0x40c00000,
        0x40e00000, 0x41000000,
      ].map((word, index) => [
        "abcdefgh"[index],
        "float",
        `fa${index}:4`,
        { [`fa${index}`]: word },
        `${index + 1}.0`,
      ]),
      [
        "value",
        "rea_riscv_abi_tagged",
        "a1:4,a0:4",
        { a1: 28, a0: 0x41dc0000 },
        "(rea_riscv_abi_tagged)0x1c41dc0000",
      ],
      ["z", "float", "a2:4", { a2: 0x41ec0000 }, "29.5"],
    ],
    stripped: { parameters: ["a0:4", "a1:4", "a2:4"] },
  },
};

const CALLER = "rea_riscv_abi_caller";

/**
 * Each float ABI the fixture is built for: its prototype, the storage table,
 * the callers whose pseudocode passes the call-site words, and the indirect
 * calls through typed pointers.
 */
export const RISCV_ABIS = {
  ilp32: {
    prototype: "__rea_ilp32",
    functions: ILP32_FUNCTIONS,
    callers: [CALLER],
    callbacks: [
      {
        caller: CALLER,
        pointer: "rea_riscv_abi_callback",
        words: { a0: 0x41a40000, a1: 0x41ac0000 },
        literals: ["20.5", "21.5"],
      },
    ],
  },
  ilp32f: {
    prototype: "__rea_ilp32f",
    functions: ILP32F_FUNCTIONS,
    callers: [CALLER, "rea_riscv_abi_single_caller"],
    callbacks: [
      {
        caller: CALLER,
        pointer: "rea_riscv_abi_callback",
        words: { fa0: 0x41a40000, fa1: 0x41ac0000 },
        literals: ["20.5", "21.5"],
      },
      {
        caller: "rea_riscv_abi_single_caller",
        pointer: "rea_riscv_abi_tagged_callback",
        words: { fa0: 0x41fc0000, a0: 32 },
        literals: ["(rea_riscv_abi_tagged)0x2041fc0000"],
      },
    ],
  },
};

const FLOAT_ARGUMENTS = [
  "fa0",
  "fa1",
  "fa2",
  "fa3",
  "fa4",
  "fa5",
  "fa6",
  "fa7",
];
const INTEGER_ARGUMENTS = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"];
// Ghidra lists inferred float parameters before integer ones, as its
// prototype lists their entries.
const LOCATION_ORDER = [...FLOAT_ARGUMENTS, ...INTEGER_ARGUMENTS, "Stack[0x0]"];
const FLOAT_REGISTER = /\bf[ast]\d+\b/u;
// Ghidra's names for a register value no prototype accounts for. A stripped
// ilp32f caller still reads `extraout_fa0`: without types Ghidra cannot recover
// a return split between float and integer registers.
const UNACCOUNTED_REGISTER = /\b(?:in|extraout)_(?:f[ast]|a)\d+/u;

const abiOf = (name) => {
  const abi = RISCV_ABIS[name];
  assert.ok(abi !== undefined, `No RISC-V ABI table ${name}`);
  return abi;
};

/** Locations named by a Ghidra storage string, such as `Stack[0x0]:4,a7:4`. */
export function riscvStorageLocations(storage) {
  return storage
    .replace(/ \(auto\)$/u, "")
    .split(",")
    .map((piece) => {
      const match = /^(.+):\d+$/u.exec(piece);
      assert.ok(match !== null, `Unexpected storage ${storage}`);
      return match[1];
    });
}

const ordered = (locations) =>
  [...locations].sort(
    (left, right) =>
      LOCATION_ORDER.indexOf(left) - LOCATION_ORDER.indexOf(right),
  );

/** How the decompiler prints a call-site word: small values in decimal. */
const printed = (word) =>
  typeof word !== "number"
    ? undefined
    : word < 10
      ? String(word)
      : `0x${word.toString(16)}`;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
// Any argument the table does not pin, including one with a cast. Ghidra
// wraps long argument lists, before an argument or before the closing ")".
const WILDCARD = "(?:\\([^()]*\\))?[^,()]+";
const SEPARATOR = ",\\s*";
const CLOSE = "\\s*\\)";

/** Every call-site word sits where the function's storage says it does. */
export function assertRiscvAbiTableConsistent(name) {
  const abi = abiOf(name);
  for (const [function_, { parameters }] of Object.entries(abi.functions))
    for (const [parameter, , storage, words] of parameters)
      if (words !== undefined)
        assert.deepEqual(
          ordered(Object.keys(words)),
          ordered(riscvStorageLocations(storage)),
          `${name} ${function_}(${parameter}) words and storage disagree`,
        );
}

/**
 * Reconstruct the argument words each call in an `llvm-objdump` listing of
 * the callers writes. It interprets only the instructions that Clang -O0 uses
 * to set up arguments, in integer and float registers; any other write leaves
 * the register unknown. Stack memory is tracked per byte, so word loads see
 * byte and halfword stores. Stack addresses are offsets from the caller's
 * incoming `sp`.
 */
export function parseRiscvCallSites(listing) {
  let caller;
  let registers;
  let bytes;
  let addresses;
  let written;
  const start = (name) => {
    caller = name;
    registers = new Map([
      ["zero", { word: 0 }],
      ["sp", { stack: 0 }],
    ]);
    bytes = new Map();
    addresses = new Map();
    written = new Set();
  };
  start(undefined);
  const calls = [];
  const immediate = (text) => {
    const value = Number.parseInt(
      text,
      text.replace(/^-/u, "").startsWith("0x") ? 16 : 10,
    );
    assert.ok(Number.isSafeInteger(value), `Unexpected immediate ${text}`);
    return value;
  };
  const address = (operand) => {
    const match = /^(-?(?:0x)?[\da-f]+)\((\w+)\)$/u.exec(operand);
    assert.ok(match !== null, `Unexpected memory operand ${operand}`);
    const base = registers.get(match[2]);
    return base?.stack === undefined
      ? undefined
      : base.stack + immediate(match[1]);
  };
  const isRegister = (operand) =>
    /^(?:zero|ra|sp|gp|tp|t[0-6]|s(?:[0-9]|1[01])|a[0-7]|f[ast]\d+)$/u.test(
      operand ?? "",
    );
  const set = (register, value) => {
    if (register === "zero") return;
    if (value === undefined) registers.delete(register);
    else registers.set(register, value);
  };
  const store = (offset, size, value) => {
    for (let index = -3; index < size; index += 1)
      addresses.delete(offset + index);
    for (let index = 0; index < size; index += 1) {
      if (value?.word === undefined) bytes.delete(offset + index);
      else bytes.set(offset + index, (value.word >>> (8 * index)) & 0xff);
    }
    // A stack address is kept whole; only a word load reads it back.
    if (value?.stack !== undefined && size === 4) addresses.set(offset, value);
    written.add(offset - (offset & 3));
  };
  const load = (offset, size, signed) => {
    if (size === 4 && addresses.has(offset)) return addresses.get(offset);
    let word = 0;
    for (let index = 0; index < size; index += 1) {
      const byte = bytes.get(offset + index);
      if (byte === undefined) return undefined;
      word |= byte << (8 * index);
    }
    const shift = 32 - 8 * size;
    return { word: (signed ? (word << shift) >> shift : word) >>> 0 };
  };
  // Every word the caller's memory holds at a call, by aligned offset.
  const wordsInMemory = () => {
    const words = new Map(addresses);
    for (const offset of bytes.keys()) {
      const aligned = offset - (offset & 3);
      const value = words.has(aligned) ? undefined : load(aligned, 4, false);
      if (value !== undefined) words.set(aligned, value);
    }
    return words;
  };
  const sizes = { b: 1, h: 2, w: 4 };
  for (const line of listing.split("\n")) {
    const header = /^\s*[\da-f]+ <([^>]+)>:\s*$/u.exec(line);
    if (header !== null) {
      start(header[1]);
      continue;
    }
    const match = /^\s*[\da-f]+:\s+([a-z.]+)(?:\s+(.*))?$/u.exec(line);
    if (match === null) continue;
    const [, mnemonic, text = ""] = match;
    const operands = text
      .replace(/\s*<[^>]*>/u, "")
      .split(",")
      .map((operand) => operand.trim())
      .filter((operand) => operand.length > 0);
    if (
      (mnemonic === "jal" && operands[0] !== "zero") ||
      mnemonic === "jalr" ||
      mnemonic === "call"
    ) {
      const sp = registers.get("sp").stack;
      const words = {};
      for (const register of [...FLOAT_ARGUMENTS, ...INTEGER_ARGUMENTS])
        words[register] = registers.get(register);
      for (const offset of written)
        if (offset >= sp)
          words[`Stack[0x${(offset - sp).toString(16)}]`] = load(
            offset,
            4,
            false,
          );
      calls.push({
        caller,
        target: mnemonic === "jalr" ? "indirect" : /<([^>]+)>/u.exec(text)?.[1],
        words,
        memory: wordsInMemory(),
      });
      // The psABI's caller-saved registers.
      for (const register of [...registers.keys()])
        if (/^(?:a[0-7]|t[0-6]|ra|f[at]\d+)$/u.test(register))
          registers.delete(register);
      written = new Set();
      continue;
    }
    const [target, source, third] = operands;
    const access = /^(f?)([ls])([bhw])(u?)$/u.exec(mnemonic);
    if (access !== null) {
      const [, , kind, width, unsigned] = access;
      const offset = address(source);
      if (kind === "s") {
        if (offset !== undefined)
          store(offset, sizes[width], registers.get(target));
      } else
        set(
          target,
          offset === undefined
            ? undefined
            : load(offset, sizes[width], unsigned === "" && width !== "w"),
        );
      continue;
    }
    switch (mnemonic) {
      case "lui":
        set(target, { word: (immediate(source) << 12) >>> 0 });
        break;
      case "li":
        set(target, { word: immediate(source) >>> 0 });
        break;
      case "mv":
      case "fmv.s":
      case "fmv.w.x":
      case "fmv.x.w":
        set(target, registers.get(source));
        break;
      case "addi": {
        const base = registers.get(source);
        set(
          target,
          base?.word !== undefined
            ? { word: (base.word + immediate(third)) >>> 0 }
            : base?.stack !== undefined
              ? { stack: base.stack + immediate(third) }
              : undefined,
        );
        break;
      }
      default:
        if (!/^(?:b[a-z]*|j|jr|ret)$/u.test(mnemonic) && isRegister(target))
          set(target, undefined);
    }
  }
  return calls;
}

/** Disassemble the typed fixture's callers with an independent LLVM tool. */
export async function inspectRiscvCallSites(path, callers) {
  const command = process.env.REA_RISCV_OBJDUMP ?? "llvm-objdump";
  const options = {
    env: { ...process.env, LC_ALL: "C" },
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  };
  const version = await execute(command, ["--version"], options);
  const { stdout, stderr } = await execute(
    command,
    [
      "-d",
      "--no-show-raw-insn",
      `--disassemble-symbols=${callers.join(",")}`,
      path,
    ],
    options,
  );
  assert.equal(stderr.trim(), "", `objdump diagnostics: ${stderr}`);
  return {
    command,
    version: version.stdout.split("\n").find((line) => /version/iu.test(line)),
    calls: parseRiscvCallSites(stdout),
  };
}

const matchesWord = (call, actual, expected) =>
  typeof expected === "number"
    ? actual?.word === expected
    : actual?.stack !== undefined &&
      (expected === "frame" ||
        expected.frame.every(
          (word, index) =>
            call.memory.get(actual.stack + 4 * index)?.word === word,
        ));

/** The compiler's call sites place every known word where the table says. */
export function assertRiscvCallSites(name, calls) {
  const abi = abiOf(name);
  assertRiscvAbiTableConsistent(name);
  const checks = [
    ...Object.entries(abi.functions).map(([function_, entry]) => [
      entry.caller ?? CALLER,
      function_,
      Object.assign(
        {},
        ...entry.parameters.map(([, , , words]) => words ?? {}),
        entry.variadic ?? {},
      ),
    ]),
    ...abi.callbacks.map((callback) => [
      callback.caller,
      "indirect",
      callback.words,
    ]),
  ];
  for (const [caller, target, words] of checks) {
    const matching = calls.filter(
      (candidate) => candidate.caller === caller && candidate.target === target,
    );
    assert.equal(
      matching.length,
      1,
      `${name}: expected one call to ${target} in ${caller}`,
    );
    for (const [location, expected] of Object.entries(words))
      assert.ok(
        matchesWord(matching[0], matching[0].words[location], expected),
        `${name} ${target}: ${location} holds ${JSON.stringify(matching[0].words[location])}, not ${JSON.stringify(expected)}`,
      );
  }
}

/**
 * Where a stripped build returns, unless the table records what Ghidra infers
 * instead: in the typed build's registers, or in none when the result goes
 * through caller memory addressed by `a0`.
 */
const strippedReturnStorage = (want) =>
  want.stripped?.return ??
  (want.parameters.some(([parameter]) => parameter === "__return_storage_ptr__")
    ? "<VOID>"
    : want.return[1]);

/**
 * Typed functions keep their names and types and use exactly the table's
 * storage. Stripped functions get one inferred word per parameter location, in
 * order, and their return storage, unless the table records what Ghidra infers
 * instead; recovered types are not compared.
 */
export function assertRiscvStorage(
  name,
  boundaries,
  { stripped = false } = {},
) {
  const abi = abiOf(name);
  assert.deepEqual(
    Object.keys(boundaries).sort(),
    Object.keys(abi.functions).sort(),
  );
  for (const [function_, want] of Object.entries(abi.functions)) {
    const boundary = boundaries[function_];
    assert.equal(boundary.calling_convention, abi.prototype, function_);
    const parameters = [...boundary.parameters].sort(
      (left, right) => left.ordinal - right.ordinal,
    );
    if (name === "ilp32")
      for (const value of [boundary.return_type, ...parameters])
        assert.doesNotMatch(value.storage ?? "", FLOAT_REGISTER, function_);
    if (stripped) {
      assert.equal(
        boundary.return_type.storage,
        strippedReturnStorage(want),
        `${function_} inferred return storage`,
      );
      if (want.variadic !== undefined) continue;
      assert.deepEqual(
        parameters.map((parameter) => parameter.storage),
        want.stripped?.parameters ??
          ordered(
            want.parameters.flatMap(([, , storage]) =>
              riscvStorageLocations(storage),
            ),
          ).map((location) => `${location}:4`),
        `${function_} inferred parameter storage`,
      );
      continue;
    }
    assert.deepEqual(
      [boundary.return_type.data_type, boundary.return_type.storage],
      want.return,
      `${function_} return storage`,
    );
    assert.deepEqual(
      parameters.map((parameter) => [
        parameter.name,
        parameter.data_type,
        parameter.storage,
      ]),
      want.parameters.map(([parameter, type, storage]) => [
        parameter,
        type,
        storage,
      ]),
      `${function_} parameter storage`,
    );
  }
}

/**
 * A caller's pseudocode passes the call-site words through the corrected
 * storage: typed literals in a typed build, words in location order in a
 * stripped one. An ilp32 caller names no float register, and a typed ilp32f
 * caller no register value outside a prototype.
 */
export function assertRiscvCaller(
  name,
  caller,
  pseudocode,
  addresses,
  { stripped = false } = {},
) {
  const abi = abiOf(name);
  if (name === "ilp32") assert.doesNotMatch(pseudocode, FLOAT_REGISTER);
  else if (!stripped) assert.doesNotMatch(pseudocode, UNACCOUNTED_REGISTER);
  for (const [function_, entry] of Object.entries(abi.functions)) {
    if (entry.variadic !== undefined || (entry.caller ?? CALLER) !== caller)
      continue;
    let call;
    if (stripped) {
      const words = Object.assign(
        {},
        ...entry.parameters.map(([, , , values]) => values ?? {}),
      );
      const locations = ordered(
        entry.parameters.flatMap(([, , storage]) =>
          riscvStorageLocations(storage),
        ),
      );
      call = `FUN_ram_0*${BigInt(addresses[function_]).toString(16)}\\(${locations
        .map((location) => {
          const word = printed(words[location]);
          return word === undefined ? WILDCARD : escape(word);
        })
        .join(SEPARATOR)}${CLOSE}`;
    } else
      call = `${function_}\\(${entry.parameters
        .map(([, , , , literal]) =>
          literal === undefined ? WILDCARD : escape(literal),
        )
        .join(SEPARATOR)}${CLOSE}`;
    assert.match(
      pseudocode,
      new RegExp(call, "u"),
      `${function_} call arguments`,
    );
  }
  for (const callback of abi.callbacks) {
    if (callback.caller !== caller) continue;
    assert.match(
      pseudocode,
      stripped
        ? new RegExp(
            `\\)\\s*\\(${Object.values(callback.words)
              .map((word) => escape(printed(word)))
              .join(SEPARATOR)}${SEPARATOR}`,
            "u",
          )
        : new RegExp(
            `\\(\\*${callback.pointer}\\)\\s*\\(${callback.literals
              .map(escape)
              .join(SEPARATOR)}${SEPARATOR}${WILDCARD}${CLOSE}`,
            "u",
          ),
      `${callback.pointer} call arguments`,
    );
  }
}
